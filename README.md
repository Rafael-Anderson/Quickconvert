# Media Downloader (local-only)

A minimal **Next.js 14** (App Router, TypeScript) app that downloads audio or
video from a URL. Everything runs on your own machine — the backend shells out
to [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and [`ffmpeg`](https://ffmpeg.org/)
directly (no npm wrappers), writes to a temp file, then streams it back to your
browser as a download.

> For personal use with content you have the right to download. Respect the
> relevant site's Terms of Service and applicable copyright law.

## Features

- Single-page UI: URL input, Audio/Video toggle, container format selector,
  quality selector, Download button.
- Loading state while the download runs.
- **Audio formats:** MP3, M4A (AAC), Opus, FLAC (lossless), WAV (lossless).
  Bitrate quality (128/192/320 kbps) for the lossy formats; lossless formats
  have no bitrate knob.
- **Video formats:** MP4, WebM, MKV, MOV. Resolution quality: **Best / 720p / 480p**.
- Quality-preserving by default: video is remuxed (`-c copy`) into the
  target container rather than re-encoded, so there's no generational
  quality loss unless the codec genuinely can't fit that container — only
  then does it fall back to re-encoding.
- **HLS/m3u8 support**: detects `.m3u8` manifests (by extension or
  `Content-Type: application/vnd.apple.mpegurl`/`x-mpegurl`) on the
  direct-link/HTML-scrape path, picks the highest-bandwidth rendition from a
  master playlist, and downloads it directly with ffmpeg.
- **Multi-threaded downloads**: `--concurrent-fragments` for yt-dlp, and
  `aria2c` (if installed) for direct-link downloads — see below.
- Verifiable output: an `X-Download-Quality` header reports the final
  file's resolution/bitrate (video) or bitrate/sample rate (audio).
- Filenames derived (and sanitized) from the video/page title.
- Temp files are deleted after the response is streamed.
- Works on more than just YouTube via a fallback chain — see below.

### Scope note

This app works with content that's openly embedded or exposed by a page
(standard `og:video` tags, `<video>` elements, JSON-LD, publicly listed HLS
manifests, or anything yt-dlp's ~1800 built-in extractors already support).
It does **not** attempt to defeat anti-scraping/DRM protections: it doesn't
decode obfuscated JS or base64 payloads to find stream URLs a site is
deliberately hiding, doesn't forward session cookies to access
authenticated/paywalled content, and doesn't reconstruct video from guessed
segment-chunk patterns when a site exposes no manifest at all. It does
forward `Referer`/`Origin`/`User-Agent` headers when fetching a URL it
already found through the methods above — many CDNs 403 requests missing
these even for public embeds, and replicating them is a compatibility fix,
not a bypass.

## Prerequisites

You must have these two binaries installed and available on your `PATH`:

| Tool     | Check              | Install                                                                 |
| -------- | ------------------ | ---------------------------------------------------------------------- |
| `yt-dlp` | `yt-dlp --version` | https://github.com/yt-dlp/yt-dlp#installation (or `pip install yt-dlp`) |
| `ffmpeg` | `ffmpeg -version`  | https://ffmpeg.org/download.html                                       |

`ffmpeg` is required for MP3 transcoding **and** for merging video+audio into
MP4. On Windows you can install both with `winget`:

```powershell
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
```

Also required: **Node.js 18.17+** (Next.js 14 minimum).

### Keeping yt-dlp updated

**Pinned/tested version: `2026.07.04`.** yt-dlp breaks whenever a site
changes its player — YouTube in particular — so an out-of-date binary is
the most common cause of downloads suddenly failing. Nothing in this app
enforces or checks a version; "pinned" just means the version this was
last verified against. Update it periodically:

```bash
npm run update-yt-dlp
```

This resolves the same binary the app itself uses (`YT_DLP_PATH` in
`.env.local`, falling back to whatever `yt-dlp` resolves to on `PATH`),
runs its self-update (`yt-dlp -U`), and prints the before/after version. If
yt-dlp was installed via `pip` rather than as a standalone binary, self-update
may be disabled — the script will tell you to run `pip install --upgrade
yt-dlp` instead.

To run it automatically:

<details>
<summary>Windows (Task Scheduler)</summary>

```powershell
schtasks /create /tn "Update yt-dlp" /sc weekly /d SUN /st 03:00 `
  /tr "cmd /c cd /d C:\path\to\this\project && npm run update-yt-dlp >> update-yt-dlp.log 2>&1"
```

</details>

<details>
<summary>macOS/Linux (cron)</summary>

```bash
# Weekly, Sunday 3am — edit with `crontab -e`
0 3 * * 0 cd /path/to/this/project && npm run update-yt-dlp >> update-yt-dlp.log 2>&1
```

</details>

### Optional: aria2c (multi-threaded direct-link downloads)

[`aria2c`](https://aria2.github.io/) is a system binary (not npm/pip) used to
accelerate the **direct-link** path (a plain progressive file URL, not an
HLS manifest — see [HLS/m3u8 support](#hlsm3u8-support)) with multiple
parallel connections. It is entirely optional: the app probes for it once
per process, logs which mode is active, and transparently falls back to a
normal single-threaded ffmpeg fetch if it isn't installed.

```bash
# Debian/Ubuntu
sudo apt install aria2

# macOS
brew install aria2

# Windows
winget install aria2.aria2
```

Pin a non-PATH install via `.env.local`:

```dotenv
ARIA2C_PATH=C:\tools\aria2c.exe
ARIA2C_CONNECTIONS=16
```

Note: `yt-dlp`'s own downloads use `--concurrent-fragments` for
multi-threading instead (see below) — aria2c is only consulted for the
direct-link fallback path, since HLS segment-by-segment fetching needs
ffmpeg's own HLS demuxer, not a generic multi-connection downloader.

### Cloudflare-protected sites (curl_cffi)

Some non-YouTube sites front their pages with a Cloudflare anti-bot challenge.
When yt-dlp's generic extractor hits this, it fails with an error like:

```
ERROR: [generic] Got HTTP Error 403 caused by Cloudflare anti-bot challenge
```

The app automatically retries that specific failure once with
`--extractor-args "generic:impersonate=chrome"`, which asks yt-dlp to present
as a real Chrome browser (TLS fingerprint included) via
[`curl_cffi`](https://github.com/lexiforest/curl_cffi). If the retry also
fails, the app falls through to the direct-link/HTML-scrape steps instead of
erroring out.

**This requires `curl_cffi` to be installed in the same Python/environment
yt-dlp runs from:**

```bash
pip install curl_cffi
```

- If you installed yt-dlp via `pip install yt-dlp`, run the command above in
  that same environment.
- If you installed the **standalone `yt-dlp.exe`** (e.g. via `winget install
  yt-dlp.yt-dlp`), it typically already bundles curl_cffi — check with
  `yt-dlp --list-impersonate-targets`; if it lists Chrome/Firefox/Safari
  targets with source `curl_cffi`, you're already covered and don't need to
  install anything separately.
- If `curl_cffi` isn't available, the impersonate retry will simply fail too
  (no crash) — the app still falls through to the rest of the fallback chain.

**Keep yt-dlp itself up to date**, since impersonation targets and site
defenses both change over time:

```bash
pip install -U yt-dlp
# or, for the standalone binary:
yt-dlp -U
```

### If the binaries are installed but the app says "not found on PATH"

This happens when the binaries were added to your PATH *after* your editor/terminal
was started, so the dev server inherited a stale PATH (common on Windows). Rather
than restarting your whole session, pin the paths explicitly in a `.env.local`
file in the project root:

```dotenv
# .env.local
YT_DLP_PATH=C:\tools\yt-dlp.exe
FFMPEG_LOCATION=C:\tools
```

- `YT_DLP_PATH` — full path to the yt-dlp binary.
- `FFMPEG_LOCATION` — the folder containing `ffmpeg` (passed to yt-dlp via
  `--ffmpeg-location`, and prepended to the child process PATH).

Both are optional — if omitted, the app just calls `yt-dlp` and relies on PATH.
Restart the dev server after changing `.env.local`.

## Setup & run

```bash
npm install
npm run dev
```

Open http://localhost:3000, paste a URL, pick a format and quality, and click
**Download**.

### Production build

```bash
npm run build
npm run start
```

## Security & operational limits

Jobs are CPU-heavy and can run for minutes, so the API enforces limits
before doing any real work. All are in-memory (single-process, local-only
app — no external store needed) and configurable via `.env.local`:

| Env var | Default | Meaning |
| --- | --- | --- |
| `MAX_CONCURRENT_JOBS` | `3` | Global cap on downloads actually running at once. |
| `MAX_QUEUE_SIZE` | `10` | Requests beyond the global cap wait here; once full, new requests get `429` immediately instead of queuing. |
| `MAX_CONCURRENT_JOBS_PER_IP` | `2` | Cap on active+queued downloads from a single IP at once. |
| `RATE_LIMIT_MAX_REQUESTS_PER_IP` | `10` | Requests per IP allowed in the rolling window below before `429`. |
| `RATE_LIMIT_WINDOW_MS` | `300000` (5 min) | Rolling window for the rate limit. |
| `MAX_FILESIZE` | `2048M` | Byte-size ceiling enforced by yt-dlp (`--max-filesize`), the direct-link ffmpeg fetch (`-fs`), and aria2c (`--max-download-limit`). Use a plain number + `k`/`M` suffix — all three tools agree on that unit. |
| `MAX_DURATION_SECONDS` | `14400` (4h) | Duration ceiling. For yt-dlp, enforced up front via `--match-filter` (also rejects livestreams outright, and rejects a video if its duration can't be determined at all — fails closed rather than risk an unbounded download). The direct-link path has no metadata preflight, so it's enforced as an ffmpeg `-t` cap on the fetch itself instead. |

A request over any of these limits gets a clear error — `429` (with a
`Retry-After` header) for the concurrency/rate limits, `422` with
`{ "error": "resource_limit_exceeded", ... }` for the size/duration limits —
rather than either silently truncating a video or the confusing generic
"no output file was produced" a rejected-but-exit-0 yt-dlp run would
otherwise produce. This is purely additive; it never changes the shape of a
successful response or of the existing error responses.

**IP detection** relies on `X-Forwarded-For` / `X-Real-IP`. This only works
correctly **behind a reverse proxy that sets those headers itself**
(nginx, Caddy, Cloudflare, etc.), overwriting anything the client sends. If
this app is ever exposed directly to the internet with no reverse proxy in
front, those headers are trivially spoofable by the client and per-IP
limiting becomes a no-op in practice — the global cap and queue still apply
regardless.

### Timeouts, process cleanup, and disconnects

Every yt-dlp/ffmpeg/aria2c/ffprobe invocation is killed as a **whole
process tree** (not just the immediate process) on timeout, on the
configured resource limits above, or if the requesting client disconnects
mid-job — `child.kill()` alone only signals the direct child, which would
leave an orphaned ffmpeg process behind when yt-dlp (its parent) is killed
for exceeding its timeout. On Windows this uses `taskkill /t`; elsewhere the
child is spawned in its own process group and the whole group is signalled.
A client disconnect also short-circuits the rest of the fallback chain
immediately (no impersonation retry, no direct-link/HTML-scrape fallback)
rather than continuing to do CPU/network work for a request nobody is
waiting on. The temp directory for a request is cleaned up on every exit
path — success, error, timeout, resource-limit rejection, and disconnect.

## How it works

- **Frontend** — [`app/page.tsx`](app/page.tsx): a client component that POSTs
  `{ url, format, quality }` to the API (`format` is the specific container,
  e.g. `"flac"` or `"mkv"`), shows a loading state, then triggers a browser
  download from the streamed response (reading the filename from
  `Content-Disposition`, and the resolution method + quality readout from the
  `X-Download-Source`/`X-Download-Quality` headers, shown alongside the
  success message).
- **Backend** — [`app/api/download/route.ts`](app/api/download/route.ts): a
  Node runtime Route Handler that validates the URL/format/quality, then
  tries each step of a fallback chain in order, using whichever one succeeds
  first:

  1. **`yt-dlp`** — natively supports ~1800 sites (YouTube, Vimeo, Twitter/X,
     TikTok, Reddit, Facebook, Instagram, Twitch, etc.):
     - **Audio:** `-x --audio-format <mp3|m4a|wav|flac|opus>` (`--audio-quality
       <kbps>K` too, for the lossy formats).
     - **Video:** `-f "bestvideo[height<=<q>]+bestaudio/best" --merge-output-format
       <mp4|webm|mkv|mov>` (or `bestvideo+bestaudio/best` for "Best") — this
       merges into the requested container without transcoding.
     - `--concurrent-fragments 8` (configurable via `YT_DLP_CONCURRENT_FRAGMENTS`)
       speeds up segmented/fragmented sources.
     - If yt-dlp reports a Cloudflare anti-bot 403, it's retried **once**
       with `--extractor-args "generic:impersonate=chrome"` (see
       [Cloudflare-protected sites](#cloudflare-protected-sites-curl_cffi)
       above) before falling through.
     - If the video merge fails because the codecs are incompatible with the
       requested container, it's retried **once** with `--recode-video
       <format>`, which forces a transcode instead of a remux.
     - Which attempt succeeded (or that all failed) is logged server-side
       only, never sent to the client.
     - Falls through to step 2 on an "unsupported URL / no formats" style
       failure, or if all yt-dlp attempts above fail — a real content error
       (private/removed/geo-blocked) is returned immediately instead of
       wasting time on the fallback.
  2. **Direct link** — if the URL itself is a media file (`.mp4`/`.webm`/
     `.mov`/`.mkv`/`.m3u8`/`.mp3`/etc., or a HEAD request shows a
     `video/`/`audio/` `Content-Type` or an HLS mimetype), it's downloaded
     straight from that URL.
  3. **HTML scrape** — otherwise, the page's HTML is fetched and searched for
     a direct media URL, in order: `og:video`/`og:video:url` meta tag →
     `<video>`/`<source>` `src` → JSON-LD `contentUrl`.
  4. If nothing is found, a structured `{ "error": "unsupported_site",
     "message": "..." }` is returned.

  Steps 2 and 3 both hand off to a shared `ffmpeg`-based downloader:

  - **HLS/m3u8**: if the resolved URL is an `.m3u8` manifest, and it's a
    master playlist (lists multiple bitrate renditions), the
    highest-bandwidth variant is selected before downloading. The stream is
    fetched with `ffmpeg -i <manifest> -c copy -bsf:a aac_adtstoasc <output>`
    (the bitstream filter fixes AAC framing when copying out of MPEG-TS),
    falling back to a full re-encode if the remux fails — yt-dlp-supported
    HLS streams need no special handling, since yt-dlp already handles those
    internally in step 1.
  - **Plain progressive files**: if [`aria2c`](#optional-aria2c-multi-threaded-direct-link-downloads)
    is available, it pre-fetches the file with multiple parallel connections
    to a local temp file first; ffmpeg then remuxes/transcodes that local
    file instead of streaming over the network. Falls back to a normal
    single-threaded ffmpeg fetch if aria2c isn't installed.
  - Every fetch forwards `Referer`/`Origin`/`User-Agent` headers matching the
    page the media was found on (see [Scope note](#scope-note)).
  - Video is remuxed (`-c copy`) into the target container first; only on
    failure does it fall back to re-encoding (`-crf 18` for mp4/mov/mkv,
    `-crf 28` for webm) — the same remux-then-re-encode pattern used for the
    [duration-metadata correction](#duration-metadata) below.

  Regardless of which step produced the file, the response includes:
  - `X-Download-Source` (`yt-dlp` | `direct-link` | `html-scrape`) — which
    step succeeded.
  - `X-Download-Quality` — the final file's resolution+bitrate (video) or
    bitrate/sample rate (audio), read back via `ffprobe` so it's verifiable
    rather than assumed.

  Every step has a timeout so one slow or unreachable site can't hang the
  request indefinitely (long real downloads still get a generous budget).

  The temp directory is deleted once the response stream closes, regardless
  of which step produced the file.

### Duration metadata

Remuxing/merging into a video container can leave the container-level
duration wildly wrong (e.g. reporting ~26113s for a 13s clip) when the
source has discontinuous/corrupted timestamps. Every video output goes
through an unconditional correction pass: remux + regenerate timestamps
(`-fflags +genpts`) first, escalating to a full re-encode if that doesn't
verifiably fix it. If the mismatch somehow persists after both passes, it's
logged as a hard warning server-side (the file still ships rather than
failing the request over a metadata cosmetic issue).

### Extending the fallback chain

Sites with an official free media API (e.g. Pexels, Pixabay) would be more
reliably handled by a dedicated per-host integration than generic HTML
scraping — see the `NOTE` above `scrapeMediaFromHtml` in
[`route.ts`](app/api/download/route.ts) for where a hostname-keyed lookup
could be added ahead of the generic scrape.

## Error handling

The API returns a JSON body with an appropriate status for:

- **400** — invalid/missing URL, unknown format, or unsupported quality.
- **422** — `{ "error": "unsupported_site", "message": "..." }` — none of the
  fallback steps could find a downloadable media URL on the page.
- **500** — `yt-dlp` or `ffmpeg` not found on `PATH`, or an unexpected failure.
- **502** — `yt-dlp` (or the direct-link/HTML-scrape downloader) ran but
  failed. For yt-dlp, the last line of its stderr is included.

## Project structure

```
app/
  api/download/route.ts   # POST handler: yt-dlp -> direct-link -> HTML-scrape fallback chain
  page.tsx                # single-page UI (client component)
  layout.tsx              # root layout
  globals.css             # styles
package.json
next.config.mjs
tsconfig.json
```

## Notes

- The app is intended for **local use only** — it runs yt-dlp on the host and
  has no authentication. Do not expose it to the public internet.
- Long videos can take a while; keep the browser tab open until the download
  finishes.
