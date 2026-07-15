import { spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

// yt-dlp / ffmpeg are native binaries + child processes — must run on Node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600; // long videos can take a while

// ---- Formats ------------------------------------------------------------------

type AudioFormat = "mp3" | "m4a" | "wav" | "flac" | "opus";
type VideoFormat = "mp4" | "webm" | "mkv" | "mov";
type Format = AudioFormat | VideoFormat;
type Source = "yt-dlp" | "direct-link" | "html-scrape";

const AUDIO_FORMATS: readonly AudioFormat[] = ["mp3", "m4a", "wav", "flac", "opus"];
const VIDEO_FORMATS: readonly VideoFormat[] = ["mp4", "webm", "mkv", "mov"];
const AUDIO_FORMAT_SET = new Set<string>(AUDIO_FORMATS);
const VIDEO_FORMAT_SET = new Set<string>(VIDEO_FORMATS);

function isValidFormat(value: unknown): value is Format {
  return typeof value === "string" && (AUDIO_FORMAT_SET.has(value) || VIDEO_FORMAT_SET.has(value));
}

function isAudioFormat(format: Format): format is AudioFormat {
  return AUDIO_FORMAT_SET.has(format);
}

// Lossless formats (wav, flac) have no meaningful bitrate knob — "best" is
// the only quality option. Video containers share the same resolution
// ladder regardless of container.
const VALID_QUALITY_BY_FORMAT: Record<Format, Set<string>> = {
  mp3: new Set(["128", "192", "320"]),
  m4a: new Set(["128", "192", "320"]),
  opus: new Set(["128", "192", "320"]),
  wav: new Set(["best"]),
  flac: new Set(["best"]),
  mp4: new Set(["best", "720", "480"]),
  webm: new Set(["best", "720", "480"]),
  mkv: new Set(["best", "720", "480"]),
  mov: new Set(["best", "720", "480"]),
};

function hasBitrateQuality(format: Format): boolean {
  return isAudioFormat(format) && VALID_QUALITY_BY_FORMAT[format].size > 1;
}

const CONTENT_TYPE_BY_FORMAT: Record<Format, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  flac: "audio/flac",
  opus: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
};

// ffmpeg codec flags for the direct-link/HLS path. Used both for audio
// extraction and as the re-encode fallback when a video remux fails.
const AUDIO_CODEC_ARGS: Record<AudioFormat, string[]> = {
  mp3: ["-acodec", "libmp3lame"],
  m4a: ["-acodec", "aac"],
  wav: ["-acodec", "pcm_s16le"],
  flac: ["-acodec", "flac"],
  opus: ["-acodec", "libopus"],
};

const VIDEO_REENCODE_CODEC_ARGS: Record<VideoFormat, string[]> = {
  mp4: ["-c:v", "libx264", "-crf", "18", "-c:a", "aac"],
  mov: ["-c:v", "libx264", "-crf", "18", "-c:a", "aac"],
  mkv: ["-c:v", "libx264", "-crf", "18", "-c:a", "aac"],
  webm: ["-c:v", "libvpx-vp9", "-crf", "28", "-b:v", "0", "-c:a", "libopus"],
};

// +faststart (moov-at-front) only makes sense for mp4/mov containers.
function muxArgsFor(format: VideoFormat): string[] {
  return format === "mp4" || format === "mov" ? ["-movflags", "+faststart"] : [];
}

// ---- Binary locations -----------------------------------------------------------

// Binary locations. These fall back to bare names (resolved via the child
// process PATH), but can be pinned via .env.local when the binaries live
// somewhere PATH doesn't cover — e.g. YT_DLP_PATH=C:\tools\yt-dlp.exe.
const YT_DLP_BIN = process.env.YT_DLP_PATH?.trim() || "yt-dlp";
// Directory containing ffmpeg, passed to yt-dlp via --ffmpeg-location and
// used to resolve the ffmpeg binary directly for the fallback download path.
const FFMPEG_LOCATION = process.env.FFMPEG_LOCATION?.trim() || "";
const FFMPEG_BIN = FFMPEG_LOCATION
  ? join(FFMPEG_LOCATION, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")
  : "ffmpeg";
const FFPROBE_BIN = FFMPEG_LOCATION
  ? join(FFMPEG_LOCATION, process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
  : "ffprobe";
// aria2c is a separate system binary (see README) used only to accelerate
// plain progressive direct-link downloads with multiple connections. Never
// required — its absence just means the single-threaded ffmpeg fetch is used.
const ARIA2C_BIN = process.env.ARIA2C_PATH?.trim() || "aria2c";
const ARIA2C_CONNECTIONS = parseInt(process.env.ARIA2C_CONNECTIONS ?? "", 10) || 16;
const YT_DLP_CONCURRENT_FRAGMENTS =
  parseInt(process.env.YT_DLP_CONCURRENT_FRAGMENTS ?? "", 10) || 8;

// spawn() with an argv array (no shell: true) skips the shell entirely for a
// real executable target — but on Windows, .bat/.cmd targets are always
// routed through cmd.exe by the OS itself, regardless of Node's `shell`
// option, which reopens argv-string metacharacter injection (&, |, ^, %).
// None of these tools should ever be configured as a batch shim; fail loudly
// at startup rather than silently regaining a shell layer. This only catches
// explicit path configuration — a bare command name (e.g. "yt-dlp") resolved
// via PATH can't be checked statically, since the extension Windows picks is
// determined at spawn time by PATHEXT.
function assertNotBatchShim(bin: string, label: string): void {
  if (/\.(bat|cmd)$/i.test(bin)) {
    throw new Error(
      `${label} is configured to a .bat/.cmd file (${bin}). Windows routes batch files through cmd.exe even without shell:true, which reopens shell-metacharacter injection — point ${label} at the real executable instead.`
    );
  }
}
assertNotBatchShim(YT_DLP_BIN, "YT_DLP_PATH");
assertNotBatchShim(FFMPEG_BIN, "FFMPEG_LOCATION (ffmpeg)");
assertNotBatchShim(FFPROBE_BIN, "FFMPEG_LOCATION (ffprobe)");
assertNotBatchShim(ARIA2C_BIN, "ARIA2C_PATH");

// Backstops so a stuck process/request can't hang the response forever.
// These are generous for the "real" download work (yt-dlp, ffmpeg fetching a
// direct URL) and short for the pure detection probes (HEAD, HTML fetch).
const YT_DLP_TIMEOUT_MS = 9 * 60_000;
const DIRECT_DOWNLOAD_TIMEOUT_MS = 3 * 60_000;
const HTML_FETCH_TIMEOUT_MS = 15_000;
const HEAD_TIMEOUT_MS = 8_000;

// ---- Resource ceilings ----------------------------------------------------------

// A livestream (or just a very large file) would otherwise run until the
// disk fills or the process timeout hits, whichever comes first — these
// give yt-dlp/ffmpeg/aria2c an explicit ceiling to enforce themselves,
// rather than relying solely on the timeout as a backstop. "M" suffix
// (megabytes) specifically because it's the one size unit all three tools
// (yt-dlp, ffmpeg, aria2c) agree on the meaning of.
const MAX_FILESIZE = process.env.MAX_FILESIZE?.trim() || "2048M";
const MAX_DURATION_SECONDS = parseInt(process.env.MAX_DURATION_SECONDS ?? "", 10) || 4 * 60 * 60;

// ---- Concurrency & rate limiting -----------------------------------------------

// Jobs are CPU-heavy (yt-dlp/ffmpeg) and can run for minutes — these bound
// how many can run at once, per-IP and globally, so a handful of requests
// (accidental or deliberate) can't queue unbounded work or starve the box.
// All in-memory (this is a single-process, local-only app; no external store
// needed) and reset if the server restarts, which is fine for this purpose.
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS ?? "", 10) || 3;
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE ?? "", 10) || 10;
const MAX_CONCURRENT_JOBS_PER_IP = parseInt(process.env.MAX_CONCURRENT_JOBS_PER_IP ?? "", 10) || 2;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "", 10) || 5 * 60_000;
const RATE_LIMIT_MAX_REQUESTS_PER_IP =
  parseInt(process.env.RATE_LIMIT_MAX_REQUESTS_PER_IP ?? "", 10) || 10;

class TooManyRequestsError extends Error {
  constructor(message: string, public retryAfterSec: number) {
    super(message);
  }
}

// Trusts X-Forwarded-For / X-Real-IP, which only makes sense behind a
// reverse proxy that sets them itself (overwriting any client-supplied
// value) — nginx, Caddy, Cloudflare, etc. If this app is ever exposed
// directly to the internet with no reverse proxy in front, these headers are
// trivially spoofable by the client and per-IP limiting below is a no-op in
// practice (every request can claim a different IP). Falls back to a single
// shared "unknown" bucket in that case, which still gets a global cap, just
// not a per-IP one.
function clientIpOf(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = req.headers.get("x-real-ip")?.trim();
  if (xri) return xri;
  return "unknown";
}

const requestTimestampsByIp = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const kept = (requestTimestampsByIp.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  kept.push(now);
  requestTimestampsByIp.set(ip, kept);
  return kept.length > RATE_LIMIT_MAX_REQUESTS_PER_IP;
}

let activeJobCount = 0;
let queuedJobCount = 0;
const inFlightByIp = new Map<string, number>(); // active + queued, per IP
const waitQueue: Array<{ resolve: () => void; ip: string }> = [];

function releaseIpSlot(ip: string): void {
  const current = inFlightByIp.get(ip) ?? 1;
  if (current <= 1) inFlightByIp.delete(ip);
  else inFlightByIp.set(ip, current - 1);
}

// Releases this job's global slot and hands it to the next queued waiter (if
// any) — synchronous, no `await` before waking the waiter, so a brand-new
// request can't race in and steal the slot ahead of whoever was already
// queued (see the comment on the wake-up path below for why that's safe).
function releaseJobSlot(ip: string): void {
  releaseIpSlot(ip);
  activeJobCount--;
  const next = waitQueue.shift();
  if (next) {
    queuedJobCount--;
    activeJobCount++;
    next.resolve();
  }
}

// Acquires a slot to actually run a job: per-IP concurrency, then the global
// cap + bounded queue — each throws TooManyRequestsError (-> 429) rather
// than ever silently queuing past the documented bound. The rate limit
// itself is checked separately, earlier, in the handler (see
// isRateLimited's call site) — before body/URL validation, not here —
// specifically so a flood of even malformed or SSRF-probing requests can't
// run up unbounded DNS lookups or reserve queue capacity; it has to fail the
// cheap in-memory rate check first. Returns a release function the caller
// must invoke exactly once (success, error, or timeout) via try/finally.
async function acquireJobSlot(req: Request, ip: string): Promise<() => void> {
  const ipCount = inFlightByIp.get(ip) ?? 0;
  if (ipCount >= MAX_CONCURRENT_JOBS_PER_IP) {
    throw new TooManyRequestsError(
      `You already have ${ipCount} download(s) in progress (max ${MAX_CONCURRENT_JOBS_PER_IP} at a time). Wait for one to finish first.`,
      15
    );
  }

  if (activeJobCount >= MAX_CONCURRENT_JOBS && queuedJobCount >= MAX_QUEUE_SIZE) {
    throw new TooManyRequestsError(
      `Server is at capacity (${MAX_CONCURRENT_JOBS} concurrent downloads, queue full). Try again shortly.`,
      15
    );
  }

  inFlightByIp.set(ip, ipCount + 1);

  if (activeJobCount < MAX_CONCURRENT_JOBS) {
    activeJobCount++;
    return () => releaseJobSlot(ip);
  }

  // Global slots are full but the queue has room — wait our turn. If the
  // client disconnects while queued, drop out immediately instead of
  // occupying a queue slot (and eventually running a job) for a request
  // nobody is waiting on anymore.
  queuedJobCount++;
  await new Promise<void>((resolve) => {
    const entry = { resolve, ip };
    waitQueue.push(entry);
    req.signal.addEventListener(
      "abort",
      () => {
        const idx = waitQueue.indexOf(entry);
        if (idx !== -1) {
          waitQueue.splice(idx, 1);
          queuedJobCount--;
          releaseIpSlot(ip);
          resolve(); // unblock acquireJobSlot; caller checks req.signal.aborted
        }
      },
      { once: true }
    );
  });

  if (req.signal.aborted) {
    // Woken up by the abort listener above, not by releaseJobSlot — no
    // active slot was ever taken for this one.
    throw new TooManyRequestsError("Client disconnected while queued.", 0);
  }

  return () => releaseJobSlot(ip);
}

const FETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Extensions that unambiguously identify a URL as a direct media file
// (includes .m3u8 — HLS manifests are handled specially, see below).
const DIRECT_MEDIA_EXTENSION_RE =
  /\.(mp4|webm|mov|mkv|m3u8|mp3|m4a|wav|flac|opus|ogg)(?:[?#]|$)/i;
// Matches both application/vnd.apple.mpegurl and application/x-mpegurl.
const HLS_CONTENT_TYPE_RE = /mpegurl/i;

// yt-dlp failure messages worth falling through the chain for, i.e. "this
// isn't a site/URL yt-dlp knows how to handle" rather than "this video is
// private/removed/geo-blocked" (which should surface as a real error).
const YT_DLP_FALLTHROUGH_RE =
  /unsupported url|no video formats found|no formats found|unable to extract|requested format is not available|is not a valid url|unable to download webpage/i;

// Some sites front their pages with a Cloudflare anti-bot challenge, which
// yt-dlp's generic extractor reports as e.g. "Got HTTP Error 403 caused by
// Cloudflare anti-bot challenge". yt-dlp's own suggested fix is browser
// impersonation via `--extractor-args "generic:impersonate=chrome"`, which
// requires the Python package `curl_cffi` to be installed alongside yt-dlp
// (pip install curl_cffi) — see README for setup notes. If curl_cffi isn't
// available, the impersonate retry below will simply fail too, which is
// fine: a failed retry just falls through to the direct-link/HTML-scrape
// steps instead of hard-stopping (see requirement 2c in the route handler).
const CLOUDFLARE_403_RE = /http error 403/i;
const CLOUDFLARE_CHALLENGE_RE = /cloudflare/i;

function isCloudflareChallenge(message: string): boolean {
  return CLOUDFLARE_403_RE.test(message) && CLOUDFLARE_CHALLENGE_RE.test(message);
}

// yt-dlp's own message when the requested --merge-output-format container
// can't hold the selected codecs without transcoding.
const YT_DLP_MERGE_INCOMPATIBLE_RE =
  /not compatible with the .* container|requested formats are incompatible|muxer does not support/i;

// yt-dlp's own message when --max-filesize or --match-filter rejects a
// video (too large, a livestream, or too long) — surfaced as a clear,
// specific error rather than falling through to the direct-link/HTML-scrape
// steps, which have no equivalent duration-limit awareness at all.
const YT_DLP_LIMIT_REJECT_RE = /max.?filesize|match.?filter|does not pass filter/i;

// ---- Errors -----------------------------------------------------------------

class BinaryMissingError extends Error {
  constructor(public binary: string) {
    super(`${binary} not found on PATH`);
  }
}

class YtDlpError extends Error {
  constructor(message: string, public code: number | null) {
    super(message);
  }
}

class TimeoutError extends Error {}

// Distinct from TimeoutError so callers can short-circuit immediately
// (skip retry/fallback attempts entirely) rather than treating it like any
// other failure worth falling through the chain for — there's no point
// retrying yt-dlp with impersonation, or falling back to direct-link
// scraping, for a client that has already left.
class ClientDisconnectedError extends Error {}

// ---- Env / process helpers ---------------------------------------------------

// Build the env for a child process. If we know the binary directories,
// prepend them to PATH so yt-dlp/ffmpeg resolve even when the server was
// launched with a stale PATH (common when a terminal predates a PATH edit).
function childEnv(): NodeJS.ProcessEnv {
  const extraDirs: string[] = [];
  if (YT_DLP_BIN.includes("\\") || YT_DLP_BIN.includes("/")) {
    extraDirs.push(dirname(YT_DLP_BIN));
  }
  if (FFMPEG_LOCATION) extraDirs.push(FFMPEG_LOCATION);
  if (extraDirs.length === 0) return process.env;

  const sep = process.platform === "win32" ? ";" : ":";
  const current = process.env.PATH ?? process.env.Path ?? "";
  return { ...process.env, PATH: [...extraDirs, current].join(sep) };
}

// child.kill() only signals the immediate process. yt-dlp shells out to
// ffmpeg itself for merging/remuxing — killing just the yt-dlp parent on
// timeout/disconnect can leave that ffmpeg grandchild running, still holding
// CPU/network/disk, orphaned from anything that would ever clean it up.
// Kills the whole descendant tree instead, cross-platform.
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    // taskkill's /t recurses the whole descendant tree; doesn't depend on
    // how the process was spawned, so this works regardless of `detached`.
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { shell: false });
  } else {
    try {
      // Negative pid signals the whole process group rather than just the
      // one process. Only valid because runChild spawns with
      // detached: true on non-Windows, which makes the child the leader of
      // its own new process group (pgid === pid) instead of sharing ours.
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

function runChild(
  bin: string,
  args: string[],
  timeoutMs: number,
  onMissing: (bin: string) => Error,
  signal?: AbortSignal,
  // Hook for a caller-specific check of stdout on an exit code 0 — needed
  // because yt-dlp exits 0 (not an error) when --match-filter rejects a
  // video, printing "does not pass filter" to stdout with no file produced.
  // Returning non-null converts that "success" into a rejection.
  onZeroExit?: (stdout: string) => Error | null
): Promise<void> {
  return new Promise((resolve, reject) => {
    // shell: false is Node's default, but set explicitly: this is the
    // invariant every call site in this file depends on for injection
    // safety (args are delivered as literal argv entries, never
    // shell-parsed) — make it impossible to lose silently in a refactor.
    // detached: true on non-Windows makes this child the leader of its own
    // process group, which killProcessTree needs to be able to signal the
    // whole tree (see its comment) rather than just this one process.
    const child = spawn(bin, args, {
      env: childEnv(),
      shell: false,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killProcessTree(child.pid);
    };
    // signal's "abort" event fires at most once, ever — if it already fired
    // before this particular call started (e.g. this is the second or third
    // subprocess spawned for a request whose client disconnected partway
    // through the first one), a fresh addEventListener here would never see
    // it. Check the already-aborted case directly instead of only relying
    // on a future event.
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 16_000) stdout = stdout.slice(-16_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      // Cap retained stderr so a chatty run can't balloon memory.
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err.code === "ENOENT" ? onMissing(bin) : err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(new ClientDisconnectedError(`${bin} aborted — client disconnected`));
      } else if (timedOut) {
        reject(new TimeoutError(`${bin} timed out after ${timeoutMs / 1000}s`));
      } else if (code === 0) {
        const rejection = onZeroExit?.(stdout);
        if (rejection) reject(rejection);
        else resolve();
      } else {
        reject(new YtDlpError(stderr.trim(), code));
      }
    });
  });
}

// Both --match-filter and --max-filesize rejections print to stdout and
// exit 0 (verified against the installed yt-dlp binary — neither is treated
// as a failure internally), e.g. "<title> does not pass filter (...),
// skipping .." or "File is larger than max-filesize (223779 bytes > 1024
// bytes). Aborting." with no output file produced either way.
const YT_DLP_STDOUT_REJECT_RE = /does not pass filter|larger than max-filesize/i;

function runYtDlp(args: string[], signal?: AbortSignal): Promise<void> {
  return runChild(
    YT_DLP_BIN,
    args,
    YT_DLP_TIMEOUT_MS,
    (bin) => new BinaryMissingError(bin),
    signal,
    (stdout) => {
      if (!YT_DLP_STDOUT_REJECT_RE.test(stdout)) return null;
      // yt-dlp exits 0 here (nothing "failed" from its point of view) but
      // produces no output file — surface it as a rejection so the existing
      // YT_DLP_LIMIT_REJECT_RE classification in the handler catches it,
      // instead of silently falling through to "no output file was produced".
      const line = stdout.split("\n").find((l) => YT_DLP_STDOUT_REJECT_RE.test(l));
      return new YtDlpError(line?.trim() || "rejected by --max-filesize/--match-filter", 0);
    }
  );
}

function runFfmpeg(
  args: string[],
  timeoutMs = DIRECT_DOWNLOAD_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<void> {
  return runChild(FFMPEG_BIN, args, timeoutMs, (bin) => new BinaryMissingError(bin), signal);
}

function runAria2c(
  args: string[],
  timeoutMs = DIRECT_DOWNLOAD_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<void> {
  return runChild(ARIA2C_BIN, args, timeoutMs, (bin) => new BinaryMissingError(bin), signal);
}

// Unlike runChild (which only cares about exit status), duration/quality
// probing needs ffprobe's stdout — the requested value is printed there,
// not stderr.
function runFfprobeCapture(args: string[], timeoutMs = 30_000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE_BIN, args, {
      env: childEnv(),
      shell: false,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killProcessTree(child.pid);
    };
    // See the matching comment in runChild: the abort event fires once
    // ever, so a signal already aborted before this call started needs an
    // immediate check, not just a listener for a future event.
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err.code === "ENOENT" ? new BinaryMissingError(FFPROBE_BIN) : err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(new ClientDisconnectedError("ffprobe aborted — client disconnected"));
      } else if (timedOut) {
        reject(new TimeoutError(`ffprobe timed out after ${timeoutMs / 1000}s`));
      } else if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
      }
    });
  });
}

// aria2c availability is probed once per server process and cached — "at
// startup" in effect, since Next.js API routes have no dedicated startup
// hook. Logs which download method is active either way; never hard-fails.
let aria2cAvailabilityPromise: Promise<boolean> | null = null;
function isAria2cAvailable(): Promise<boolean> {
  if (!aria2cAvailabilityPromise) {
    aria2cAvailabilityPromise = new Promise<boolean>((resolve) => {
      const probe = spawn(ARIA2C_BIN, ["--version"], { env: childEnv(), shell: false });
      let settled = false;
      const finish = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      probe.on("error", () => finish(false));
      probe.on("close", (code) => finish(code === 0));
    }).then((available) => {
      console.log(
        `[download] aria2c ${
          available
            ? `detected — will use ${ARIA2C_CONNECTIONS} connections for direct-link downloads`
            : "not found — falling back to single-threaded fetch for direct-link downloads (see README to install)"
        }`
      );
      return available;
    });
  }
  return aria2cAvailabilityPromise;
}

// ---- Generic helpers ----------------------------------------------------------

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function sanitizeFilename(name: string): string {
  return (
    name
      // Strip characters illegal in filenames on Windows/most OSes. This
      // keeps non-ASCII letters (e.g. Japanese, accents) — those are valid
      // filename chars and are carried by the filename*= header.
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180) || "download"
  );
}

function resolveUrl(maybeRelative: string, base: string): string {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

function basenameFromUrl(rawUrl: string): string {
  try {
    const { pathname } = new URL(rawUrl);
    const last = pathname.split("/").filter(Boolean).pop();
    return last ? last.replace(/\.[a-z0-9]+$/i, "") : "download";
  } catch {
    return "download";
  }
}

function hostnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl;
  }
}

// ---- SSRF guard ---------------------------------------------------------------

class UnsafeUrlError extends Error {}

function isBlockedIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // malformed — treat as blocked rather than risk a bypass
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // loopback, 127.0.0.0/8
  if (a === 10) return true; // private, 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private, 172.16/12
  if (a === 192 && b === 168) return true; // private, 192.168/16
  if (a === 169 && b === 254) return true; // link-local, 169.254/16
  return false;
}

// /10 and /7 prefixes both land on a boundary within the address's first
// 16-bit group, so comparing that group numerically is exact (not a rough
// heuristic): fe80::/10 is every address whose first group is 0xfe80-0xfebf,
// and fc00::/7 is every address whose first group is 0xfc00-0xfdff.
function ipv6FirstHextet(address: string): number {
  const head = address.split("::")[0].split(":")[0];
  return head ? parseInt(head, 16) : 0;
}

function isBlockedIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true; // loopback / unspecified
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(normalized);
  if (mapped) return isBlockedIPv4(mapped[1]); // IPv4-mapped IPv6
  const first = ipv6FirstHextet(normalized);
  if (first >= 0xfe80 && first <= 0xfebf) return true; // link-local, fe80::/10
  if (first >= 0xfc00 && first <= 0xfdff) return true; // unique local, fc00::/7
  return false;
}

const DNS_LOOKUP_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 5;

// The single choke point every user-URL-fetching step routes through: yt-dlp
// (validated once, up front — yt-dlp's own subsequent internal requests and
// redirects happen entirely inside that subprocess and are NOT visible to us;
// see the caveat in the handler), the direct-link HEAD probe, the HTML scrape
// fetch, and HLS variant resolution (via safeFetch below, which re-runs this
// on every redirect hop it follows).
//
// Checks the *resolved* IP addresses, not the hostname string — a hostname
// check alone is bypassable by pointing an attacker-controlled domain at a
// private/loopback/link-local IP. Uses dns.lookup() (getaddrinfo) rather than
// a raw DNS query specifically because it also resolves "localhost" and any
// /etc/hosts-style entries, which a protocol-level DNS query would miss.
async function assertSafeUrl(rawUrl: string): Promise<URL> {
  // new URL() silently strips embedded CR/LF while parsing, so this has to
  // run against the raw string — otherwise a URL smuggles extra lines into
  // the Referer/Origin header blobs built for ffmpeg's -headers and aria2c's
  // --header (CRLF/header injection into our own outbound requests).
  if (/[\x00-\x1f\x7f]/.test(rawUrl)) {
    throw new UnsafeUrlError("URL contains control characters.");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("Invalid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeUrlError(`Unsupported URL scheme "${parsed.protocol}" — only http/https are allowed.`);
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new UnsafeUrlError(`DNS lookup for "${parsed.hostname}" timed out.`)),
        DNS_LOOKUP_TIMEOUT_MS
      );
      dnsLookup(parsed.hostname, { all: true, verbatim: true }).then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    throw new UnsafeUrlError(`Could not resolve host "${parsed.hostname}".`);
  }
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`Could not resolve host "${parsed.hostname}".`);
  }
  for (const { address, family } of addresses) {
    const blocked = family === 6 ? isBlockedIPv6(address) : isBlockedIPv4(address);
    if (blocked) {
      throw new UnsafeUrlError(`Host "${parsed.hostname}" resolves to a disallowed address.`);
    }
  }
  return parsed;
}

// fetch() wrapper used for every step that fetches a URL ourselves (not
// yt-dlp/ffmpeg/aria2c, which do their own networking as a subprocess — see
// the caveat where each of those is invoked). Follows redirects manually
// (capped) instead of via `redirect: "follow"` specifically so
// assertSafeUrl runs again on each hop: validating only the first hop would
// let an allowed host redirect straight to a blocked address.
async function safeFetch(
  initialUrl: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; ; hop++) {
    if (outerSignal?.aborted) throw new ClientDisconnectedError("client disconnected");
    await assertSafeUrl(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
    let res: Response;
    try {
      res = await fetch(currentUrl, { ...init, redirect: "manual", signal: controller.signal });
    } catch (err) {
      if (outerSignal?.aborted) throw new ClientDisconnectedError("client disconnected");
      throw err;
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onOuterAbort);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) return res;
      if (hop >= MAX_REDIRECTS) {
        throw new UnsafeUrlError(`Too many redirects (>${MAX_REDIRECTS}) resolving ${initialUrl}.`);
      }
      currentUrl = resolveUrl(location, currentUrl);
      continue;
    }
    return res;
  }
}

// Forwards the headers a browser would naturally send when the page itself
// requests this media (Referer/Origin), on top of the existing User-Agent.
// Many CDNs 403 a request that's missing these even for openly embedded,
// non-authenticated video — this is a compatibility fix for the URL our
// existing (non-obfuscated) detection already found, not a bypass technique.
// Deliberately does NOT forward cookies/session state.
function buildRefererHeaderArgs(pageUrl: string): string[] {
  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    /* ignore */
  }
  const lines = [`Referer: ${pageUrl}`];
  if (origin) lines.push(`Origin: ${origin}`);
  return ["-headers", lines.join("\r\n") + "\r\n"];
}

// ---- HLS helpers ----------------------------------------------------------------

function looksLikeHlsManifest(mediaUrl: string): boolean {
  try {
    return /\.m3u8(?:[?#]|$)/i.test(new URL(mediaUrl).pathname);
  } catch {
    return /\.m3u8/i.test(mediaUrl);
  }
}

// If the manifest is a master playlist (lists multiple bitrate renditions),
// resolves to the highest-bandwidth variant's media playlist so we download
// the best quality rather than whatever ffmpeg would pick by default.
// Falls back to the original URL on any failure or if it's already a media
// playlist (no #EXT-X-STREAM-INF entries).
async function resolveBestHlsMediaPlaylist(
  manifestUrl: string,
  pageUrl: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    const res = await safeFetch(
      manifestUrl,
      { headers: { "User-Agent": FETCH_USER_AGENT, Referer: pageUrl } },
      HTML_FETCH_TIMEOUT_MS,
      signal
    );
    if (!res.ok) return manifestUrl;
    const text = await res.text();
    if (!/#EXT-X-STREAM-INF/i.test(text)) return manifestUrl;

    let bestBandwidth = -1;
    let bestUrl: string | null = null;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/i.exec(lines[i]);
      if (m) {
        const next = lines[i + 1]?.trim();
        if (next && !next.startsWith("#")) {
          const bw = parseInt(m[1], 10);
          if (bw > bestBandwidth) {
            bestBandwidth = bw;
            bestUrl = next;
          }
        }
      }
    }
    return bestUrl ? resolveUrl(bestUrl, manifestUrl) : manifestUrl;
  } catch {
    return manifestUrl;
  }
}

// ---- Video duration metadata correction ----------------------------------------

// Remuxing (-c copy) or merging (yt-dlp's --merge-output-format) can leave a
// video container's duration wildly larger than the media actually plays
// for — e.g. reporting ~26113s for a 13s clip — when the source has
// discontinuous/corrupted timestamps. The ratio/delta check below is used
// only to decide whether a correction pass *worked*, never to decide whether
// to run one — every video output goes through correction unconditionally.
const DURATION_MISMATCH_RATIO = 3;
const DURATION_MISMATCH_MIN_DELTA_SEC = 5;

function isDurationMismatch(formatDuration: number, streamDuration: number): boolean {
  return (
    formatDuration > streamDuration * DURATION_MISMATCH_RATIO &&
    formatDuration - streamDuration > DURATION_MISMATCH_MIN_DELTA_SEC
  );
}

// Whether a correction pass can be trusted as having fixed the duration.
// Some containers (mkv/webm in particular) simply don't expose a per-stream
// duration tag the way mp4/mov do via mdhd/tkhd — that's a container-format
// limitation, not evidence of a mismatch. Only escalate to the next
// correction step when we have positive evidence of a problem (both values
// known and disagreeing), never just because one value is unavailable.
function passVerified(formatDuration: number | null, streamDuration: number | null): boolean {
  if (formatDuration == null) return false;
  if (streamDuration == null) return true;
  return !isDurationMismatch(formatDuration, streamDuration);
}

async function probeDuration(
  filePath: string,
  entries: "format=duration" | "stream=duration",
  signal?: AbortSignal
): Promise<number | null> {
  try {
    const args =
      entries === "format=duration"
        ? ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath]
        : [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            filePath,
          ];
    const out = await runFfprobeCapture(args, 30_000, signal);
    const value = parseFloat(out);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    // Probe failures (missing ffprobe, unreadable file, no such tag, etc.)
    // are treated as "unknown".
    return null;
  }
}

async function replaceWithCorrection(filePath: string, candidatePath: string): Promise<void> {
  await rename(candidatePath, filePath);
}

// Unconditionally corrects the duration metadata on every video file this
// app produces (from yt-dlp's merge or our own -c copy remux), regardless of
// whether a mismatch was detected beforehand. Runs entirely on the local
// file — no network access. Never throws: a failed correction still ships
// the file rather than failing the whole download, but is logged loudly.
//
// Escalation ladder:
//   1. Remux + regenerate timestamps + force the duration into the
//      container via -metadata (cheap, tried first for every file).
//   2. If that doesn't verifiably fix it, fully re-encode instead of
//      copying streams — this rebuilds every timestamp from decoded
//      frames rather than trusting anything from the source container.
//   3. Re-probe the final result; if it's *still* mismatched, log a hard
//      warning so a silently-broken file never goes unnoticed.
async function fixDurationMetadataIfNeeded(
  filePath: string,
  originalUrl: string,
  source: Source,
  format: VideoFormat,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return; // client's gone — no point starting a re-encode pass for nobody

  const host = hostnameOf(originalUrl);
  const mux = muxArgsFor(format);

  let [formatDuration, streamDuration] = await Promise.all([
    probeDuration(filePath, "format=duration", signal),
    probeDuration(filePath, "stream=duration", signal),
  ]);

  console.log(
    `[download] running unconditional duration correction (${source} via ${host}, ${format}): container=${
      formatDuration != null ? formatDuration.toFixed(3) + "s" : "unknown"
    }, stream=${streamDuration != null ? streamDuration.toFixed(3) + "s" : "unknown"}`
  );

  // The stream-level duration is what the media actually plays for; that's
  // the value we want the container to agree with. Fall back to whatever
  // format-level value we have if the stream tag is missing.
  const referenceSeconds = streamDuration ?? formatDuration;
  let fixedByMetadataPass = false;

  if (referenceSeconds != null) {
    const pass1Path = `${filePath}.pass1.${format}`;
    try {
      // Pass 1: remux, regenerate timestamps, and explicitly force the
      // known-good duration into the container header.
      await runFfmpeg(
        [
          "-y",
          "-i",
          filePath,
          "-c",
          "copy",
          "-fflags",
          "+genpts",
          ...mux,
          "-metadata",
          `duration=${referenceSeconds.toFixed(3)}`,
          pass1Path,
        ],
        DIRECT_DOWNLOAD_TIMEOUT_MS,
        signal
      );
      const pass1Format = await probeDuration(pass1Path, "format=duration", signal);
      const pass1Stream = await probeDuration(pass1Path, "stream=duration", signal);
      if (pass1Format != null && passVerified(pass1Format, pass1Stream)) {
        await replaceWithCorrection(filePath, pass1Path);
        console.log(
          `[download] duration corrected via -metadata remux for ${host}: now ${pass1Format.toFixed(3)}s`
        );
        fixedByMetadataPass = true;
        formatDuration = pass1Format;
        streamDuration = pass1Stream;
      } else {
        await rm(pass1Path, { force: true }).catch(() => {});
        console.error(
          `[download] -metadata remux pass did not verifiably fix duration for ${host} (container=${
            pass1Format?.toFixed(3) ?? "unknown"
          }s, stream=${pass1Stream?.toFixed(3) ?? "unknown"}s) — escalating to full re-encode`
        );
      }
    } catch (err) {
      await rm(pass1Path, { force: true }).catch(() => {});
      console.error(
        `[download] -metadata remux pass failed for ${host}: ${
          err instanceof Error ? err.message : err
        } — escalating to full re-encode`
      );
    }
  } else {
    console.error(
      `[download] no usable reference duration for ${host} — skipping the -metadata pass, going straight to full re-encode`
    );
  }

  if (!fixedByMetadataPass && signal?.aborted) {
    return; // client's gone — don't start a full re-encode for nobody
  }

  if (!fixedByMetadataPass) {
    // Pass 2: skip -c copy entirely. Fully re-encoding forces ffmpeg to
    // rebuild every timestamp from decoded frames instead of trusting
    // anything carried over from the source container.
    const pass2Path = `${filePath}.pass2.${format}`;
    try {
      await runFfmpeg(
        [
          "-y",
          "-i",
          filePath,
          ...VIDEO_REENCODE_CODEC_ARGS[format],
          "-fflags",
          "+genpts",
          ...mux,
          pass2Path,
        ],
        DIRECT_DOWNLOAD_TIMEOUT_MS,
        signal
      );
      await replaceWithCorrection(filePath, pass2Path);
      [formatDuration, streamDuration] = await Promise.all([
        probeDuration(filePath, "format=duration", signal),
        probeDuration(filePath, "stream=duration", signal),
      ]);
      console.log(
        `[download] re-encoded ${host} to fix duration metadata: now container=${
          formatDuration?.toFixed(3) ?? "unknown"
        }s, stream=${streamDuration?.toFixed(3) ?? "unknown"}s`
      );
    } catch (err) {
      await rm(pass2Path, { force: true }).catch(() => {});
      console.error(
        `[download] HARD WARNING: full re-encode correction failed for ${host} (${source}) — shipping file with unverified/possibly-incorrect duration metadata:`,
        err instanceof Error ? err.message : err
      );
      return;
    }
  }

  // Final verification, regardless of which pass produced the file — never
  // ship a broken file silently without at least logging it loudly.
  if (formatDuration != null && streamDuration != null && isDurationMismatch(formatDuration, streamDuration)) {
    console.error(
      `[download] HARD WARNING: duration mismatch persists after correction for ${host} (${source}): container=${formatDuration.toFixed(
        3
      )}s vs stream=${streamDuration.toFixed(3)}s — shipping file with incorrect duration metadata anyway`
    );
  }
}

// ---- Quality probing (requirement 3: verifiable resolution/bitrate) ------------

async function probeVideoQuality(filePath: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const out = await runFfprobeCapture(
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,bit_rate",
        "-of",
        "csv=p=0",
        filePath,
      ],
      30_000,
      signal
    );
    const [w, h, br] = out.split(",");
    const width = parseInt(w, 10);
    const height = parseInt(h, 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    const bitrate = br && br !== "N/A" ? parseInt(br, 10) : NaN;
    return `${width}x${height}${Number.isFinite(bitrate) ? ` @ ${Math.round(bitrate / 1000)}kbps` : ""}`;
  } catch {
    return null;
  }
}

async function probeAudioQuality(filePath: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const out = await runFfprobeCapture(
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=bit_rate,sample_rate",
        "-of",
        "csv=p=0",
        filePath,
      ],
      30_000,
      signal
    );
    const [br, sr] = out.split(",");
    const bitrate = br && br !== "N/A" ? parseInt(br, 10) : NaN;
    const sampleRate = sr && sr !== "N/A" ? parseInt(sr, 10) : NaN;
    const parts: string[] = [Number.isFinite(bitrate) ? `${Math.round(bitrate / 1000)}kbps` : "lossless"];
    if (Number.isFinite(sampleRate)) parts.push(`${sampleRate}Hz`);
    return parts.join(" @ ");
  } catch {
    return null;
  }
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function structuredJsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tooManyRequestsResponse(err: TooManyRequestsError): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (err.retryAfterSec > 0) headers["Retry-After"] = String(err.retryAfterSec);
  return new Response(JSON.stringify({ error: "too_many_requests", message: err.message }), {
    status: 429,
    headers,
  });
}

// 499 (nginx's unofficial "Client Closed Request") rather than 200/500 —
// nobody receives this response (the client is already gone), but it keeps
// server-side logs honest about why the job stopped rather than looking
// like a generic failure.
function clientDisconnectedResponse(host: string): Response {
  console.log(`[download] client disconnected mid-job for ${host} — job stopped, process tree killed, temp files cleaned up`);
  return jsonError("Client disconnected.", 499);
}

// ---- Step (a): yt-dlp ---------------------------------------------------------

function buildYtDlpArgs(
  url: string,
  format: Format,
  quality: string,
  outputTemplate: string,
  opts: { impersonate?: boolean; forceRecode?: boolean } = {}
): string[] {
  const ffmpegLoc = FFMPEG_LOCATION ? ["--ffmpeg-location", FFMPEG_LOCATION] : [];
  // Retry-only flag (see CLOUDFLARE_403_RE above) — asks yt-dlp's generic
  // extractor to present as a real Chrome via curl_cffi TLS fingerprinting.
  const impersonateArgs = opts.impersonate
    ? ["--extractor-args", "generic:impersonate=chrome"]
    : [];
  const common = [
    ...ffmpegLoc,
    ...impersonateArgs,
    "--no-playlist",
    "--no-progress",
    // Fail fast on hung connections instead of retrying indefinitely.
    "--socket-timeout",
    "15",
    // Multi-threaded segment fetching for DASH/HLS-fragmented sources.
    "--concurrent-fragments",
    String(YT_DLP_CONCURRENT_FRAGMENTS),
    // Resource ceilings: reject outright rather than downloading partway —
    // a livestream (is_live) has no real end, and duration is checked
    // strictly (rejected if unknown, not just if too long) since we'd
    // rather decline a video we can't verify the length of than risk an
    // unbounded download.
    "--max-filesize",
    MAX_FILESIZE,
    "--match-filter",
    `!is_live & duration<${MAX_DURATION_SECONDS}`,
    "-o",
    outputTemplate,
    url,
  ];

  if (isAudioFormat(format)) {
    const audioArgs = ["-x", "--audio-format", format];
    if (hasBitrateQuality(format)) audioArgs.push("--audio-quality", `${quality}K`);
    return [...audioArgs, ...common];
  }

  const formatSelector =
    quality === "best"
      ? "bestvideo+bestaudio/best"
      : `bestvideo[height<=${quality}]+bestaudio/best`;

  // Quality-preserving: merge the separately-downloaded best video+audio
  // streams into the requested container without transcoding. If the codec
  // combination genuinely can't be muxed into that container, yt-dlp errors
  // and the caller retries with --recode-video, which forces a transcode
  // (see the merge-incompatibility branch in the handler below).
  const containerArgs = opts.forceRecode
    ? ["--recode-video", format]
    : ["--merge-output-format", format];

  return ["-f", formatSelector, ...containerArgs, ...common];
}

// ---- Step (b): is the URL itself a direct media file? -------------------------

async function detectDirectMediaUrl(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const { pathname } = new URL(url);
    if (DIRECT_MEDIA_EXTENSION_RE.test(pathname)) return url;
  } catch {
    return null;
  }

  // No recognizable extension — probe via HEAD and inspect Content-Type.
  // Some servers reject/ignore HEAD; a false negative here just falls
  // through to the HTML-scrape step, which is an acceptable trade-off.
  try {
    const res = await safeFetch(
      url,
      { method: "HEAD", headers: { "User-Agent": FETCH_USER_AGENT } },
      HEAD_TIMEOUT_MS,
      signal
    );
    const contentType = res.headers.get("content-type") || "";
    if (/^(video|audio)\//i.test(contentType) || HLS_CONTENT_TYPE_RE.test(contentType)) return url;
  } catch {
    /* not a direct file, the probe failed/timed out, or it resolved to a
       disallowed address (see assertSafeUrl) */
  }
  return null;
}

// ---- Step (c): scrape the page's HTML for a media URL -------------------------

interface ScrapedMedia {
  mediaUrl: string;
  title: string | null;
}

function extractHtmlTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return m ? m[1].trim() : null;
}

// NOTE: sites with an official free media API (e.g. Pexels, Pixabay) would be
// more reliably handled by a dedicated per-host integration — hitting their
// API instead of scraping markup that can change at any time. Not implemented
// yet; a good extension point is a hostname-keyed lookup at the top of this
// function that returns early, before falling back to the generic scrape below.
//
// Scope note: this deliberately only looks at openly-exposed, standard
// markers (og:video, <video>/<source>, JSON-LD contentUrl). It does not
// attempt to decode obfuscated JS/base64 payloads or otherwise hunt for
// stream URLs a site is deliberately hiding — that crosses from "parse what
// the page already publishes" into circumventing a site's own protections,
// which is out of scope for this tool.
async function scrapeMediaFromHtml(pageUrl: string, signal?: AbortSignal): Promise<ScrapedMedia | null> {
  let html: string;
  try {
    const res = await safeFetch(
      pageUrl,
      { headers: { "User-Agent": FETCH_USER_AGENT } },
      HTML_FETCH_TIMEOUT_MS,
      signal
    );
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const title = extractHtmlTitle(html);

  // 1. og:video / og:video:url / og:video:secure_url meta tag.
  const ogVideo =
    /<meta[^>]+property=["']og:video(?::(?:url|secure_url))?["'][^>]+content=["']([^"']+)["']/i.exec(
      html
    ) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::(?:url|secure_url))?["']/i.exec(
      html
    );
  if (ogVideo) {
    return { mediaUrl: resolveUrl(ogVideo[1], pageUrl), title };
  }

  // 2. <video>/<source> src attribute.
  const videoTag = /<(?:video|source)[^>]+src=["']([^"']+)["']/i.exec(html);
  if (videoTag) {
    return { mediaUrl: resolveUrl(videoTag[1], pageUrl), title };
  }

  // 3. JSON-LD contentUrl field.
  for (const block of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const parsed = JSON.parse(block[1]);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of candidates) {
        const contentUrl = item?.contentUrl ?? item?.video?.contentUrl ?? item?.embedUrl;
        if (typeof contentUrl === "string") {
          return { mediaUrl: resolveUrl(contentUrl, pageUrl), title: item?.name ?? title };
        }
      }
    } catch {
      /* not valid JSON-LD — skip this block */
    }
  }

  return null;
}

// ---- Steps (b)/(c) shared download: fetch the resolved direct URL -------------

// Pre-downloads a plain progressive file with aria2c's multiple connections,
// returning the local temp file path on success. Only meaningful for a
// single HTTP(S) file — an HLS manifest needs ffmpeg's own segment-aware
// demuxer, not a generic multi-connection downloader, so this is never
// called for HLS sources. Returns null (never throws) on any failure so the
// caller can fall back to a direct single-threaded ffmpeg fetch.
async function aria2cPredownload(
  sourceUrl: string,
  pageUrl: string,
  dir: string,
  signal?: AbortSignal
): Promise<string | null> {
  const destName = "aria2_source";
  const destPath = join(dir, destName);
  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    /* ignore */
  }

  const args = [
    "-x",
    String(ARIA2C_CONNECTIONS),
    "-s",
    String(ARIA2C_CONNECTIONS),
    "--min-split-size=1M",
    // Resource ceiling: abort rather than fetch an unbounded stream — this
    // path has no metadata preflight (unlike yt-dlp's --match-filter), so a
    // hard byte cap during the fetch itself is the only backstop available.
    `--max-download-limit=${MAX_FILESIZE}`,
    "--allow-overwrite=true",
    "--auto-file-renaming=false",
    "--summary-interval=0",
    "--console-log-level=warn",
    "--dir",
    dir,
    "--out",
    destName,
    "--user-agent",
    FETCH_USER_AGENT,
    "--header",
    `Referer: ${pageUrl}`,
    ...(origin ? ["--header", `Origin: ${origin}`] : []),
    sourceUrl,
  ];

  try {
    await runAria2c(args, DIRECT_DOWNLOAD_TIMEOUT_MS, signal);
    return destPath;
  } catch (err) {
    console.error(
      `[download] aria2c pre-download failed, falling back to direct ffmpeg fetch: ${
        err instanceof Error ? err.message : err
      }`
    );
    return null;
  }
}

async function downloadDirectMedia(
  sourceUrl: string,
  format: Format,
  quality: string,
  dir: string,
  titleHint: string | null,
  pageUrl: string,
  isHls: boolean,
  signal?: AbortSignal
): Promise<void> {
  const base = sanitizeFilename(titleHint || basenameFromUrl(sourceUrl));
  const outputPath = join(dir, `${base}.${format}`);

  let inputUrl = sourceUrl;
  let usingLocalFile = false;

  // aria2c only helps for a single progressive file over plain HTTP — an
  // HLS manifest must be understood segment-by-segment, which is ffmpeg's
  // own HLS demuxer's job, not a generic multi-connection downloader's.
  if (!isHls && (await isAria2cAvailable())) {
    const localPath = await aria2cPredownload(sourceUrl, pageUrl, dir, signal);
    if (localPath) {
      inputUrl = localPath;
      usingLocalFile = true;
      console.log(`[download] using aria2c-fetched local file as ffmpeg input for ${hostnameOf(pageUrl)}`);
    }
  }

  // Headers only matter for network input — a local (aria2c-fetched) file
  // needs neither User-Agent nor Referer/Origin.
  const networkArgs = usingLocalFile
    ? []
    : ["-user_agent", FETCH_USER_AGENT, ...buildRefererHeaderArgs(pageUrl)];

  // Resource ceiling for this path (no metadata preflight like yt-dlp's
  // --match-filter, so this is the only backstop): -t stops encoding once
  // the output reaches this duration — this is what actually prevents a
  // live/infinite HLS or direct stream from running until the disk fills.
  // -fs is a byte-size backstop on top of that.
  const limitArgs = ["-t", String(MAX_DURATION_SECONDS), "-fs", MAX_FILESIZE];

  if (isAudioFormat(format)) {
    const bitrateArgs = hasBitrateQuality(format) ? ["-b:a", `${quality}k`] : [];
    await runFfmpeg(
      [
        "-y",
        ...networkArgs,
        "-i",
        inputUrl,
        "-vn",
        ...AUDIO_CODEC_ARGS[format],
        ...bitrateArgs,
        ...limitArgs,
        outputPath,
      ],
      DIRECT_DOWNLOAD_TIMEOUT_MS,
      signal
    );
    return;
  }

  // Video: a generically-scraped page/manifest rarely exposes multiple
  // renditions to choose from directly (HLS master-playlist bandwidth
  // selection already happened before this function was called), so the
  // resolution quality selector isn't honored here — we take whatever
  // single stream was resolved. Try a fast remux first (quality-preserving,
  // no re-encode), falling back to a full re-encode only if that fails.
  // aac_adtstoasc is required specifically when copying AAC audio out of an
  // MPEG-TS-sourced HLS stream into an mp4/mov/mkv container.
  const hlsBsf = isHls ? ["-bsf:a", "aac_adtstoasc"] : [];
  const mux = muxArgsFor(format);
  try {
    await runFfmpeg(
      [
        "-y",
        ...networkArgs,
        "-fflags",
        "+genpts",
        "-i",
        inputUrl,
        "-c",
        "copy",
        ...hlsBsf,
        ...mux,
        ...limitArgs,
        outputPath,
      ],
      DIRECT_DOWNLOAD_TIMEOUT_MS,
      signal
    );
  } catch {
    if (signal?.aborted) throw new ClientDisconnectedError("client disconnected during direct-media download");
    await runFfmpeg(
      [
        "-y",
        ...networkArgs,
        "-fflags",
        "+genpts",
        "-i",
        inputUrl,
        ...VIDEO_REENCODE_CODEC_ARGS[format],
        ...mux,
        ...limitArgs,
        outputPath,
      ],
      DIRECT_DOWNLOAD_TIMEOUT_MS,
      signal
    );
  }
}

// ---- Handler ----------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  // Rate limit first, before spending any effort on parsing/validating the
  // body or resolving DNS for the SSRF check — otherwise a flood of garbage
  // or SSRF-probing requests would run up real work for free every time by
  // failing validation before ever reaching this check.
  const clientIp = clientIpOf(req);
  if (isRateLimited(clientIp)) {
    return tooManyRequestsResponse(
      new TooManyRequestsError(
        `Rate limit exceeded (max ${RATE_LIMIT_MAX_REQUESTS_PER_IP} requests per ${Math.round(
          RATE_LIMIT_WINDOW_MS / 1000
        )}s). Try again later.`,
        Math.round(RATE_LIMIT_WINDOW_MS / 1000)
      )
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid request body — expected JSON.", 400);
  }

  const { url, format, quality } = (body ?? {}) as {
    url?: unknown;
    format?: unknown;
    quality?: unknown;
  };

  // --- Validate input ---
  if (typeof url !== "string" || !isValidHttpUrl(url)) {
    return jsonError("Please provide a valid http(s) URL.", 400);
  }
  if (!isValidFormat(format)) {
    return jsonError(
      `Format must be one of: ${[...AUDIO_FORMATS, ...VIDEO_FORMATS].join(", ")}.`,
      400
    );
  }
  if (typeof quality !== "string") {
    return jsonError("Missing quality selection.", 400);
  }
  if (!VALID_QUALITY_BY_FORMAT[format].has(quality)) {
    return jsonError(`Unsupported quality "${quality}" for ${format}.`, 400);
  }

  // SSRF guard on the URL as given by the client — scheme + resolved-IP
  // checks (see assertSafeUrl). This is the only validation possible for the
  // yt-dlp path: once yt-dlp is spawned below, it performs its own HTTP
  // requests (including any redirects it follows) entirely inside that
  // subprocess, invisible to us — we cannot re-validate hops yt-dlp itself
  // makes. The direct-link/HTML-scrape/HLS steps below get hop-by-hop
  // re-validation via safeFetch because our own code does that networking.
  try {
    await assertSafeUrl(url);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Unsafe URL.", 400);
  }

  // --- Concurrency gate: acquire a slot before doing any real work (temp
  // dir, subprocesses). Everything from here to the final return (all
  // success and error paths) is wrapped in try/finally so the slot is always
  // released exactly once, however the request ends. ---
  let releaseSlot: () => void;
  try {
    releaseSlot = await acquireJobSlot(req, clientIp);
  } catch (err) {
    if (err instanceof TooManyRequestsError) return tooManyRequestsResponse(err);
    throw err;
  }

  try {
    return await handleDownload(req, url, format, quality);
  } finally {
    releaseSlot();
  }
}

async function handleDownload(
  req: Request,
  url: string,
  format: Format,
  quality: string
): Promise<Response> {
  // --- Download to an isolated temp dir ---
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), "ytdl-"));
  } catch {
    return jsonError("Could not create a temp directory for the download.", 500);
  }
  const cleanup = () => {
    rm(dir, { recursive: true, force: true }).catch(() => {
      /* best-effort */
    });
  };

  let source: Source | null = null;
  let ytDlpNote: string | null = null;

  // --- Step (a): yt-dlp, which natively supports ~1800 sites -------------------
  const outputTemplate = join(dir, "%(title)s.%(ext)s");
  try {
    await runYtDlp(buildYtDlpArgs(url, format, quality, outputTemplate), req.signal);
    source = "yt-dlp";
    console.log("[download] yt-dlp succeeded (plain attempt, no impersonation needed)");
  } catch (err) {
    if (err instanceof ClientDisconnectedError) {
      // Client's gone — stop immediately rather than retrying with
      // impersonation or falling through to direct-link/HTML-scrape for a
      // request nobody is waiting on anymore. killProcessTree already
      // stopped the yt-dlp (and any ffmpeg it spawned) process tree.
      cleanup();
      return clientDisconnectedResponse(hostnameOf(url));
    }
    if (err instanceof YtDlpError) {
      if (isCloudflareChallenge(err.message)) {
        // Retry once with browser impersonation before giving up on yt-dlp
        // entirely. This is a separate spawn with its own fresh timeout
        // budget (YT_DLP_TIMEOUT_MS again) — not an extension of the first
        // call's deadline.
        console.error(
          "[download] yt-dlp hit a Cloudflare challenge on the plain attempt; retrying with --extractor-args generic:impersonate=chrome"
        );
        try {
          await runYtDlp(
            buildYtDlpArgs(url, format, quality, outputTemplate, { impersonate: true }),
            req.signal
          );
          source = "yt-dlp";
          console.log("[download] yt-dlp succeeded on the impersonate retry");
        } catch (retryErr) {
          if (retryErr instanceof ClientDisconnectedError) {
            cleanup();
            return clientDisconnectedResponse(hostnameOf(url));
          }
          console.error(
            "[download] yt-dlp impersonate retry also failed:",
            retryErr instanceof Error ? retryErr.message : retryErr
          );
          // Per spec: a failed impersonation retry is not a hard stop —
          // fall through to the direct-link / HTML-scrape steps below,
          // exactly like any other fallthrough-worthy yt-dlp failure.
          ytDlpNote = "hit a Cloudflare challenge (plain and impersonate attempts both failed)";
        }
        // Skip the generic classification below — Cloudflare/403 has
        // already been handled (either source is set, or ytDlpNote is).
      } else if (!isAudioFormat(format) && YT_DLP_MERGE_INCOMPATIBLE_RE.test(err.message)) {
        // The requested container can't hold the selected codecs without
        // transcoding. Retry once with --recode-video, which forces yt-dlp
        // to transcode into the container instead of just merging streams.
        console.error(
          `[download] yt-dlp could not merge into ${format} (container/codec incompatibility); retrying with --recode-video ${format} (forced transcode)`
        );
        try {
          await runYtDlp(
            buildYtDlpArgs(url, format, quality, outputTemplate, { forceRecode: true }),
            req.signal
          );
          source = "yt-dlp";
          console.log(`[download] yt-dlp succeeded via --recode-video ${format}`);
        } catch (recodeErr) {
          if (recodeErr instanceof ClientDisconnectedError) {
            cleanup();
            return clientDisconnectedResponse(hostnameOf(url));
          }
          console.error(
            "[download] --recode-video retry also failed:",
            recodeErr instanceof Error ? recodeErr.message : recodeErr
          );
          ytDlpNote = `could not produce a valid ${format} container (remux and forced re-encode both failed)`;
        }
      } else if (/ffmpeg|ffprobe/i.test(err.message)) {
        // ffmpeg is required for both audio transcode and video merge — if
        // that's what's broken, the fallback path needs it too, so surface now.
        cleanup();
        return jsonError(
          "ffmpeg appears to be missing or failed. Install ffmpeg and ensure it is on PATH.",
          500
        );
      } else if (YT_DLP_LIMIT_REJECT_RE.test(err.message)) {
        // Rejected by --max-filesize/--match-filter (too large, live, or too
        // long) — a hard stop, not a fallthrough case: the direct-link/HTML-
        // scrape steps have no equivalent duration/filesize awareness for
        // this specific URL (yt-dlp's ffmpeg-level -fs/-t backstops in
        // downloadDirectMedia only apply to the generic fallback path).
        cleanup();
        return structuredJsonError(
          "resource_limit_exceeded",
          `This video exceeds the configured limit (max ${MAX_FILESIZE}, max ${Math.round(
            MAX_DURATION_SECONDS / 3600
          )}h, no livestreams).`,
          422
        );
      } else if (!YT_DLP_FALLTHROUGH_RE.test(err.message)) {
        // A real content-level failure (private/removed/geo-blocked/etc.) —
        // not "wrong site", so don't waste time on the generic fallback.
        cleanup();
        const detail = err.message.split("\n").filter(Boolean).pop() || "";
        return jsonError(
          `yt-dlp failed to download this video.${detail ? ` (${detail})` : ""}`,
          502
        );
      } else {
        ytDlpNote = "reported an unsupported URL or no formats";
      }
    } else if (err instanceof TimeoutError) {
      ytDlpNote = "timed out";
    } else if (err instanceof BinaryMissingError) {
      // yt-dlp isn't installed — the fallback steps below don't need it.
      ytDlpNote = "is not installed";
    } else {
      cleanup();
      return jsonError("Unexpected error while downloading.", 500);
    }
  }

  // --- Steps (b) & (c): generic fallback for sites yt-dlp can't handle --------
  if (!source) {
    let directUrl = await detectDirectMediaUrl(url, req.signal);
    let titleHint: string | null = null;

    if (directUrl) {
      source = "direct-link";
    } else {
      const scraped = await scrapeMediaFromHtml(url, req.signal);
      if (scraped) {
        directUrl = scraped.mediaUrl;
        titleHint = scraped.title;
        source = "html-scrape";
      }
    }

    if (!directUrl) {
      cleanup();
      if (req.signal.aborted) return clientDisconnectedResponse(hostnameOf(url));
      return structuredJsonError(
        "unsupported_site",
        `Could not find a downloadable video on this page.${
          ytDlpNote ? ` (yt-dlp ${ytDlpNote})` : ""
        }`,
        422
      );
    }

    const isHls = looksLikeHlsManifest(directUrl);
    if (isHls) {
      directUrl = await resolveBestHlsMediaPlaylist(directUrl, url, req.signal);
    }

    // Re-validate: directUrl may now be either an HTML-scraped mediaUrl or an
    // HLS-resolved variant URL — both extracted from third-party content we
    // don't control, not just the client's original input, so they get the
    // same scrutiny even though the original `url` was already checked above.
    try {
      await assertSafeUrl(directUrl);
    } catch (err) {
      cleanup();
      return jsonError(err instanceof Error ? err.message : "Unsafe URL.", 400);
    }

    try {
      await downloadDirectMedia(directUrl, format, quality, dir, titleHint, url, isHls, req.signal);
    } catch (err) {
      cleanup();
      if (err instanceof ClientDisconnectedError) {
        return clientDisconnectedResponse(hostnameOf(url));
      }
      if (err instanceof BinaryMissingError) {
        return jsonError(
          "ffmpeg was not found on PATH. Install it and make sure it is runnable from your terminal.",
          500
        );
      }
      return jsonError("Found a media link on this page, but downloading it failed.", 502);
    }
  }

  if (!source) {
    cleanup();
    return jsonError("Unexpected error while downloading.", 500);
  }

  if (req.signal.aborted) {
    // Client's gone by the time we'd otherwise start post-processing —
    // don't spend a duration-correction re-encode pass on a file nobody
    // will receive.
    cleanup();
    return clientDisconnectedResponse(hostnameOf(url));
  }

  // --- Locate the produced file (shared by every path above) ---
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    cleanup();
    return jsonError("Could not read the downloaded file.", 500);
  }
  if (files.length === 0) {
    cleanup();
    return jsonError("No output file was produced.", 500);
  }

  const filePath = join(dir, files[0]);

  // Video containers (from either the yt-dlp merge or our own -c copy remux)
  // can end up with a corrupt container-level duration; detect and correct
  // that in place before the file is sized/streamed. No-op for audio.
  if (!isAudioFormat(format)) {
    await fixDurationMetadataIfNeeded(filePath, url, source, format, req.signal);
  }

  // Verifiable quality readout (resolution+bitrate for video, bitrate/sample
  // rate for audio), logged server-side and surfaced via a response header.
  const quality_ =
    (!isAudioFormat(format)
      ? await probeVideoQuality(filePath, req.signal)
      : await probeAudioQuality(filePath, req.signal)) ?? "unknown";
  console.log(`[download] final output quality (${source}, ${format}): ${quality_}`);

  let size: number;
  try {
    ({ size } = await stat(filePath));
  } catch {
    cleanup();
    return jsonError("Could not read the downloaded file.", 500);
  }
  const downloadName = sanitizeFilename(files[0]);
  // HTTP header values must be Latin-1 (bytes 0-255). Titles often contain
  // characters outside that range, which would make `new Response(...)`
  // throw. Use an ASCII-only fallback for the plain filename= param;
  // filename*=UTF-8'' carries the real Unicode name for modern browsers.
  const asciiName = downloadName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'") || "download";

  // --- Stream the file back, cleaning up when the stream ends ---
  const nodeStream = createReadStream(filePath);
  nodeStream.on("close", cleanup);
  nodeStream.on("error", cleanup);

  const webStream = Readable.toWeb(nodeStream) as unknown as NodeWebReadableStream<Uint8Array>;

  return new Response(webStream as unknown as ReadableStream, {
    headers: {
      "Content-Type": CONTENT_TYPE_BY_FORMAT[format],
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(
        downloadName
      )}`,
      "Cache-Control": "no-store",
      "X-Download-Source": source,
      "X-Download-Quality": quality_,
    },
  });
}
