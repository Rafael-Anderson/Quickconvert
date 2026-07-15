// Integration tests for app/api/download/route.ts, run with:
//   node --experimental-transform-types --experimental-test-module-mocks --test tests/
//
// Design notes (read before extending this file):
//
// - The route module is imported directly and its POST() handler invoked
//   with a constructed Request — no real HTTP server, no `next dev`/`next
//   start` process. This is faster and more deterministic than spinning up
//   a server, and exercises the exact same code the app runs in production.
//
// - Node's built-in type-stripping alone can't handle this codebase's use
//   of TypeScript parameter properties (e.g. `constructor(message: string,
//   public retryAfterSec: number)` in the route's error classes), hence
//   --experimental-transform-types instead of relying on the stripped-only
//   default. Both flags are Node core features, not third-party tooling.
//
// - yt-dlp/ffmpeg/ffprobe/aria2c are invoked via node:child_process's
//   spawn(), which is mocked here via node:test's mock.module() (hence
//   --experimental-test-module-mocks) rather than real subprocesses. This
//   keeps the suite hermetic: it does not require yt-dlp/ffmpeg to be
//   installed on the machine running the tests (CI included), and it can't
//   be flaky due to real downloads. The one exception is a single,
//   explicitly-conditional real-yt-dlp smoke test that self-skips when
//   yt-dlp isn't actually available (see "real yt-dlp" below).
//
//   IMPORTANT: mock.module() for a given built-in specifier only takes
//   effect the *first* time it's called in the process — calling it again
//   for "node:child_process" after a .restore() does NOT re-intercept
//   (confirmed empirically against this Node version; not documented
//   behavior to rely on elsewhere). So the spawn mock is installed exactly
//   once, at module load time, for the whole file — never re-mocked or
//   restored per-block. This is fine here because every test in this file
//   wants the same fake-subprocess behavior (see fakeSpawn below); if a
//   future test needs different spawn behavior, it should read from a
//   shared mutable config object rather than trying to re-mock.
//
// - The one-time real-yt-dlp availability probe below deliberately runs
//   BEFORE the spawn mock is installed, using the real, unmocked spawnSync.
//
// - Outbound HTTP fetches the app makes itself (HEAD probes, HTML scrape,
//   HLS manifest resolution) are mocked via a plain `globalThis.fetch`
//   reassignment per-test — no experimental flag needed for that, since
//   fetch is a plain global, not a module import, so normal reassign/
//   restore works without any of the mock.module caveats above.
//
// - Every test URL uses the "example.com" hostname. This is intentional:
//   example.com/.net/.org are permanently reserved by IANA for
//   documentation/testing and always resolve to a real, stable public IP —
//   so the app's real SSRF guard (assertSafeUrl) does a real DNS lookup and
//   passes it naturally, without needing DNS itself to be mocked. Only the
//   HTTP layer past that point is faked.
//
// - Concurrency/rate-limit state in the route module is process-global and
//   keyed by the caller's IP (X-Forwarded-For). Tests that aren't
//   specifically exercising rate limiting use a fresh synthetic IP per
//   request (see freshIp()) so they can't contaminate each other's
//   counters — clientIpOf() doesn't validate that the header looks like a
//   real IP, so any unique string works as a key.

import { spawnSync } from "node:child_process";
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

// ---- One-time setup: probe real yt-dlp availability BEFORE mocking --------
//
// Used only to decide whether the "real yt-dlp" smoke test below can run —
// this probe itself happens before the spawn mock is installed, against the
// genuine, unmocked node:child_process.

const YT_DLP_BIN_FOR_PROBE = process.env.YT_DLP_PATH?.trim() || "yt-dlp";
let realYtDlpAvailable = false;
try {
  const result = spawnSync(YT_DLP_BIN_FOR_PROBE, ["--version"], { shell: false });
  realYtDlpAvailable = result.status === 0;
} catch {
  realYtDlpAvailable = false;
}

// ---- One-time setup: install the spawn mock (see design note above) -------

// Toggled by the one "yt-dlp succeeds" test to exercise that branch of the
// fallback chain hermetically (no real yt-dlp needed) instead of leaving it
// untested — reset back to "unavailable" immediately after that test so it
// doesn't leak into the rest of the suite (see design note above on why
// this is a shared mutable flag rather than a per-test re-mock).
let ytDlpBehavior: "unavailable" | "succeed" = "unavailable";

type SpawnCall = { bin: string; args: string[] };
const spawnCalls: SpawnCall[] = [];

// A fake, in-process replacement for node:child_process's spawn(), dispatched
// by which real binary the call is meant for (matched by substring, so it
// works whether route.ts resolves e.g. "yt-dlp" or "C:\tools\yt-dlp.exe").
// Returns an EventEmitter shaped enough like a ChildProcess for route.ts's
// runChild()/runFfprobeCapture() to drive to completion.
function fakeSpawn(bin: string, args: string[] = []) {
  spawnCalls.push({ bin, args });
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.pid = 10_000 + spawnCalls.length;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};

  const lower = bin.toLowerCase();

  if (lower.includes("yt-dlp") && ytDlpBehavior === "succeed") {
    // yt-dlp's real output filename depends on the video's title
    // (%(title)s.%(ext)s in the -o template), which we're not simulating —
    // just drop a fake file directly in the requested output directory, the
    // same way handleDownload's readdir(dir)-then-take-files[0] logic would
    // pick up a real yt-dlp output regardless of its exact name.
    const oIndex = args.indexOf("-o");
    const outputTemplate = oIndex !== -1 ? args[oIndex + 1] : null;
    setImmediate(() => {
      try {
        if (outputTemplate) {
          const dir = dirname(outputTemplate);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "Fake Video Title.bin"), Buffer.from("fake-ytdlp-output"));
        }
      } catch {
        /* if this throws, the test assertion below will surface it */
      }
      child.emit("close", 0);
    });
  } else if (lower.includes("aria2c") || lower.includes("yt-dlp")) {
    // Simulate "not installed" for both — for aria2c this is the app's
    // normal, expected graceful-fallback path; for yt-dlp (when
    // ytDlpBehavior is "unavailable", the default) this forces every other
    // test in this file down the generic direct-link/HTML-scrape fallback
    // deterministically, regardless of whether yt-dlp happens to be
    // installed on whatever machine runs the suite.
    setImmediate(() => child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })));
  } else if (lower.includes("ffprobe")) {
    // Generic plausible probe output — enough to satisfy whichever of
    // probeDuration/probeVideoQuality/probeAudioQuality is asking, all of
    // which just parseFloat/split(",") whatever ffprobe printed.
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("128000,44100\n"));
      child.emit("close", 0);
    });
  } else if (lower.includes("ffmpeg")) {
    // Simulate a successful fetch+transcode: write a small real file to the
    // output path (always the last argv element for every ffmpeg
    // invocation in downloadDirectMedia/fixDurationMetadataIfNeeded) so the
    // route's subsequent readdir/stat/createReadStream calls have a real
    // file to work with, then exit 0.
    const outputPath = args[args.length - 1];
    setImmediate(() => {
      try {
        writeFileSync(outputPath, Buffer.from("fake-media-bytes"));
      } catch {
        /* if this throws, the test assertion below will surface it */
      }
      child.emit("close", 0);
    });
  } else {
    setImmediate(() => child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })));
  }

  return child;
}

mock.module("node:child_process", { exports: { spawn: fakeSpawn } });

// Imported AFTER the mock above is installed, so route.ts's own `import {
// spawn } from "node:child_process"` resolves to the fake.
const { POST } = await import("../app/api/download/route.ts");

// ---- Test harness helpers -------------------------------------------------

let ipCounter = 0;
function freshIp(): string {
  return `test-ip-${++ipCounter}`;
}

function postRequest(body: unknown, ip: string): Request {
  return new Request("http://localhost/api/download", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify(body),
  });
}

const realFetch = globalThis.fetch;
function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

// ---- 1. Fallback chain: yt-dlp -> direct link -> HTML scrape -> 422 -------

describe("fallback chain", () => {
  it("yt-dlp unavailable + direct media extension -> direct-link success (200)", async () => {
    // No fetch mock needed: detectDirectMediaUrl matches the .mp4 extension
    // in the pathname before it would ever need to make a HEAD request.
    const res = await POST(
      postRequest({ url: "https://example.com/sample-video.mp4", format: "mp3", quality: "320" }, freshIp())
    );
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get("X-Download-Source"), "direct-link");
  });

  it("yt-dlp unavailable + no extension but scraped og:video -> html-scrape success (200)", async () => {
    mockFetch(async (url, init) => {
      if (init?.method === "HEAD") {
        // Not a recognizable media content-type -> falls through to scrape.
        return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url === "https://example.com/watch-page") {
        return new Response(
          `<html><head><meta property="og:video" content="https://example.com/scraped-media.mp4"></head></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    try {
      const res = await POST(
        postRequest({ url: "https://example.com/watch-page", format: "mp3", quality: "320" }, freshIp())
      );
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(res.headers.get("X-Download-Source"), "html-scrape");
    } finally {
      restoreFetch();
    }
  });

  it("yt-dlp unavailable + nothing scrapable -> 422 unsupported_site", async () => {
    mockFetch(async (url, init) => {
      if (init?.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("<html><body>just a plain page, no media here</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    try {
      const res = await POST(
        postRequest({ url: "https://example.com/nothing-here", format: "mp3", quality: "320" }, freshIp())
      );
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.equal(body.error, "unsupported_site");
    } finally {
      restoreFetch();
    }
  });

  it("yt-dlp succeeds -> response uses source yt-dlp, fallback steps skipped entirely", async () => {
    ytDlpBehavior = "succeed";
    try {
      const res = await POST(
        postRequest({ url: "https://example.com/some-watch-page", format: "mp3", quality: "320" }, freshIp())
      );
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(res.headers.get("X-Download-Source"), "yt-dlp");
    } finally {
      ytDlpBehavior = "unavailable"; // don't leak into later tests
    }
  });

  it(
    "(informational) real yt-dlp binary is available on this machine",
    { skip: realYtDlpAvailable ? false : "yt-dlp is not available in this environment — expected in CI" },
    () => {
      // Not a functional assertion — this file mocks spawn globally (see
      // the design note at the top), so it can't exercise a real yt-dlp
      // process itself without a separate, unmocked test file/process. This
      // just records whether that would even be possible in the current
      // environment, so a CI run's skip here reads as expected/environmental
      // rather than as a silent gap. The "yt-dlp succeeds" case immediately
      // above tests the real routing/classification logic (source becomes
      // "yt-dlp", the direct-link/HTML-scrape steps are skipped) via the
      // mocked yt-dlp success path instead.
      assert.ok(realYtDlpAvailable);
    }
  );
});

// ---- 2. Rate limiting: 10 req/IP per 5min -> 429 ---------------------------

describe("rate limiting", () => {
  it("allows 10 requests per IP, rejects the 11th with 429", async () => {
    const ip = freshIp();
    // Deliberately invalid URL so each request fails fast (400) without
    // touching the network/subprocess layer — only the rate-limit counter,
    // which is checked before any of that, matters here.
    const payload = { url: "not-a-url", format: "mp3", quality: "320" };

    for (let i = 0; i < 10; i++) {
      const res = await POST(postRequest(payload, ip));
      assert.equal(res.status, 400, `request ${i + 1} should be a normal validation failure, not rate-limited`);
    }

    const eleventh = await POST(postRequest(payload, ip));
    assert.equal(eleventh.status, 429);
    const body = await eleventh.json();
    assert.equal(body.error, "too_many_requests");
    assert.ok(eleventh.headers.get("Retry-After"), "expected a Retry-After header on 429");
  });

  it("a different IP is unaffected by another IP's rate limit", async () => {
    const res = await POST(postRequest({ url: "not-a-url", format: "mp3", quality: "320" }, freshIp()));
    assert.equal(res.status, 400);
  });
});

// ---- 3. SSRF guard ----------------------------------------------------------

describe("SSRF guard", () => {
  const blocked = [
    "http://localhost/x",
    "http://127.0.0.1/x",
    "http://127.0.0.1:8080/x",
    "http://192.168.1.1/x",
    "http://192.168.0.50/x",
    "http://10.0.0.1/x",
    "http://10.255.255.255/x",
    "http://172.16.0.1/x",
    "http://172.31.255.255/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/x",
  ];

  for (const url of blocked) {
    it(`rejects ${url}`, async () => {
      const res = await POST(postRequest({ url, format: "mp3", quality: "320" }, freshIp()));
      assert.equal(res.status, 400, `expected ${url} to be rejected`);
      const body = await res.json();
      assert.match(body.error, /disallowed address/i, `expected an SSRF rejection for ${url}, got: ${body.error}`);
    });
  }

  it("does not block a normal public host (172.32.x.x is outside the blocked 172.16-31 range)", async () => {
    // 172.32.0.1 looks superficially similar to the blocked 172.16/12 range
    // but is outside it (172.16-31 only) — a boundary check that the range
    // comparison isn't accidentally over-broad. yt-dlp is mocked to fail
    // fast (see top of file); fetch is mocked here too (a real HEAD/GET
    // against an arbitrary unreachable IP would otherwise hang for many
    // seconds on real network/OS-level connection timeouts, which is what
    // was actually happening here before this mock was added — it was
    // never about spawn). The point of this test is purely that
    // assertSafeUrl doesn't reject it; it must specifically NOT be an SSRF
    // rejection.
    mockFetch(() => new Response("not found", { status: 404 }));
    try {
      const res = await POST(postRequest({ url: "http://172.32.0.1/x", format: "mp3", quality: "320" }, freshIp()));
      const body = await res.json();
      assert.doesNotMatch(String(body.error ?? body.message ?? ""), /disallowed address/i);
    } finally {
      restoreFetch();
    }
  });
});

// ---- 4. Format allowlist ----------------------------------------------------

describe("format allowlist", () => {
  const maliciousFormats = [
    "mp4; rm -rf /",
    "../../../etc/passwd",
    "mp4' OR '1'='1",
    "<script>alert(1)</script>",
    "",
    "MP4", // case must match exactly — not accepted as a loose variant
    "mp4\x00.exe",
  ];

  for (const format of maliciousFormats) {
    it(`rejects format ${JSON.stringify(format)}`, async () => {
      // A blocked URL here is irrelevant — format is validated before the
      // URL is ever resolved, so any well-formed http(s) URL works as a
      // neutral stand-in.
      const res = await POST(postRequest({ url: "https://example.com/x", format, quality: "320" }, freshIp()));
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /Format must be one of/i);
    });
  }

  const validFormatsWithQuality: Array<[string, string]> = [
    ["mp3", "320"],
    ["m4a", "320"],
    ["opus", "320"],
    ["wav", "best"],
    ["flac", "best"],
    ["mp4", "best"],
    ["webm", "best"],
    ["mkv", "best"],
    ["mov", "best"],
  ];

  for (const [format, quality] of validFormatsWithQuality) {
    it(`accepts format "${format}" (passes validation, rejected later for an unrelated reason)`, async () => {
      // Use an SSRF-blocked URL as a cheap, mock-free way to prove the
      // request got PAST format validation: if format were rejected, the
      // error would say "Format must be one of"; instead it must fail at
      // the SSRF stage specifically, proving the allowlist accepted it.
      const res = await POST(postRequest({ url: "http://127.0.0.1/x", format, quality }, freshIp()));
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.doesNotMatch(body.error, /Format must be one of/i);
      assert.match(body.error, /disallowed address/i);
    });
  }
});
