# Security

QuickExtract downloads user-supplied media URLs on the server, via a
combination of in-process code and external subprocess tools (yt-dlp,
ffmpeg, aria2c). That combination — fetching arbitrary URLs on a user's
behalf, server-side — is inherently SSRF-shaped, so this document exists to
be explicit about what's actually mitigated, what isn't, and what to do
about the gap.

## 1. Known gap: subprocess networking is not covered by the SSRF guard

The app's SSRF guard (`assertSafeUrl()` in
[`app/api/download/route.ts`](app/api/download/route.ts)) validates a URL —
scheme, and the *resolved* IP address of its hostname against a blocklist —
before that URL is used anywhere. For the three fetches the app's own Node
code performs itself (the direct-link HEAD probe, the HTML scrape, HLS
manifest resolution), this guard runs again on every redirect hop, via a
`safeFetch()` wrapper that follows redirects manually instead of trusting
`fetch`'s built-in `redirect: "follow"`.

**What it does not cover:** once a validated URL is handed to yt-dlp,
ffmpeg, or aria2c as a subprocess, those tools perform their own DNS
resolution and their own HTTP requests — including following their own
redirects — entirely outside this process. A URL that passes `assertSafeUrl`
at hand-off time could still redirect, once inside that subprocess, to an
internal address our guard never gets a chance to re-check.

**Why it isn't closed:** closing this fully means never letting yt-dlp/
ffmpeg/aria2c make their own outbound connections at all — instead, fetching
every byte through our own validated, redirect-checked Node code, and
piping that into ffmpeg via stdin or a local temp file, or replicating
yt-dlp's fetch layer entirely. That's a real architecture change (a
byte-fetching proxy layer in front of three different subprocess tools,
each with their own retry/range-request/streaming behavior to reproduce),
not a guard function. It has been deliberately not done as part of this
hardening pass; see mitigation below for what's in place instead.

## 2. Mitigation: network-level egress firewall

Because the gap above is a subprocess making its own connections, the
guard against it can't live in this app's own code — it has to live at the
network layer, blocking the *subprocess binaries* from reaching private
address space regardless of what URL they were told to fetch. Scope the
block to the subprocess binaries specifically (`yt-dlp`, `ffmpeg`,
`aria2c`), not the Node/`next start` process itself — the app server may
have legitimate reasons to reach private addresses (a reverse proxy, a
database), but the download tools never should.

Block outbound connections from those binaries to: loopback
(`127.0.0.0/8`, `::1`), RFC 1918 private ranges (`10.0.0.0/8`,
`172.16.0.0/12`, `192.168.0.0/16`), and link-local (`169.254.0.0/16`) — the
same ranges `assertSafeUrl` already blocks at the application layer, now
enforced independently at the OS layer too.

### Linux (iptables)

Run the download tools under a dedicated, unprivileged user
(e.g. `quickextract-worker`) and scope the rules to that user with
`--uid-owner`, so this doesn't depend on iptables being able to distinguish
processes by binary path:

```bash
for net in 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16; do
  iptables -A OUTPUT -m owner --uid-owner quickextract-worker -d "$net" -j REJECT
done
```

If the app itself doesn't already run its subprocess tools as a separate
user, that's a prerequisite for this to be enforceable this way — otherwise
apply the rules to the whole app user, which also blocks the Node process's
own outbound access to private ranges (fine for a purely public-internet
deployment; a problem if the app needs to reach anything internal, like a
reverse proxy or database on a private IP).

### Windows Server (Windows Firewall)

Scope by binary path instead, since Windows Firewall rules can target a
specific executable directly:

```powershell
$blockedRanges = "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16"
$binaries = @{
  "yt-dlp" = "C:\tools\yt-dlp.exe"
  "ffmpeg" = "C:\tools\ffmpeg.exe"
  "aria2c" = "C:\tools\aria2c.exe"
}
foreach ($name in $binaries.Keys) {
  New-NetFirewallRule -DisplayName "Block egress to private ranges ($name)" `
    -Direction Outbound -Program $binaries[$name] `
    -RemoteAddress $blockedRanges -Action Block
}
```

Adjust the paths to match wherever `YT_DLP_PATH`/`FFMPEG_LOCATION`/
`ARIA2C_PATH` actually point (see `.env.local`) — the firewall rule has to
target the exact binary path the app is configured to invoke.

**Deployment note:** these Windows Firewall rules are required on the
WebAiry VPS deployment specifically, since that's a Windows Server target —
they are not optional hardening there, they're the only mechanism that
closes gap #1 above for that deployment. No further WebAiry-specific
guidance is included here beyond standard Windows Firewall configuration,
since nothing about WebAiry's environment beyond "it's a Windows Server VPS"
is known to this document's author at time of writing — confirm the actual
binary install paths and firewall/console access model on that host before
applying the commands above.

## 3. Hardening completed

| Area | What's in place | Where |
| --- | --- | --- |
| Command injection | Every subprocess call uses `spawn(bin, argsArray, { shell: false })` — args are delivered as literal argv entries, never shell-parsed. `format`/`quality` are validated against a hardcoded allowlist before reaching any subprocess. A startup check rejects any configured binary path ending in `.bat`/`.cmd` (which Windows would otherwise route through `cmd.exe` regardless of `shell: false`). | `runChild()`, `assertNotBatchShim()`, `isValidFormat()` in `app/api/download/route.ts` |
| SSRF | `assertSafeUrl()` resolves the hostname via DNS and checks the *resolved* IP (not the hostname string) against loopback/private/link-local ranges, for both IPv4 and IPv6. Re-validated on every redirect hop for the app's own fetches. See gap #1 above for what this does not cover. | `assertSafeUrl()`, `safeFetch()` |
| Rate limiting | 10 requests per IP per 5-minute rolling window (`RATE_LIMIT_MAX_REQUESTS_PER_IP` / `RATE_LIMIT_WINDOW_MS`), checked before body parsing or any DNS/network work. Also: a global concurrency cap (3 simultaneous jobs), a per-IP concurrency cap (2), and a bounded queue (10) — all env-configurable, all `429` on rejection. | `isRateLimited()`, `acquireJobSlot()` |
| Resource caps | `MAX_FILESIZE` (default `2048M`) and `MAX_DURATION_SECONDS` (default `14400`, 4h) — enforced via yt-dlp's `--max-filesize`/`--match-filter` (which also rejects livestreams outright, and rejects any video whose duration can't be determined — fails closed), and via ffmpeg's `-fs`/`-t` for the direct-link fallback path, which has no metadata preflight to reject up front. | `buildYtDlpArgs()`, `downloadDirectMedia()` |
| Process cleanup | Every yt-dlp/ffmpeg/ffprobe/aria2c invocation is killed as a whole process tree (not just the immediate process) on timeout or client disconnect — `taskkill /t /f` on Windows, process-group `SIGKILL` elsewhere. A client disconnect short-circuits the rest of the fallback chain immediately rather than continuing work for a request nobody is waiting on. Temp directories are cleaned up on every exit path (success, error, timeout, resource-limit rejection, disconnect). | `killProcessTree()`, `runChild()` |
| yt-dlp freshness | Pinned/tested version documented in `README.md` (currently `2026.07.04`), with `npm run update-yt-dlp` (`scripts/update-yt-dlp.mjs`) to self-update the configured binary, and documented Task Scheduler/cron examples for running it on a schedule. This is a documented and tooled process, not a runtime-enforced version pin — the app itself doesn't check or lock a yt-dlp version, since it's a system binary, not an npm dependency. | `README.md` § Keeping yt-dlp updated |
| Dependency CVEs | `.github/workflows/security.yml` runs `npm audit` on every push to `main` and fails the build on any high/critical finding. | `.github/workflows/security.yml` |
| Automated regression coverage | `tests/integration.test.ts` — fallback chain, rate limiting, SSRF guard, format allowlist. Runs in the CI workflow above. | `tests/integration.test.ts` |

## 4. Responsible disclosure

If you find a security issue in QuickExtract, please **do not open a public
GitHub issue**. Email:

**`rohaan18069dxb@gmail.com`**

with a description of the issue and, if possible, steps to reproduce it.
Public issues for unpatched vulnerabilities put every deployment at risk in
the window before a fix ships — private disclosure gives that window a
chance to not be exploited first.

## 5. Deployment note

This app is deployed on a **WebAiry VPS running Windows Server**. The
Windows Firewall rules in §2 are required there, not optional — that
deployment has no other enforcement point for gap #1. Before going live on
that host, confirm:

- `YT_DLP_PATH` / `FFMPEG_LOCATION` / `ARIA2C_PATH` in `.env.local` point at
  the actual installed binary locations on that VPS (the firewall rules
  must target those exact paths).
- The Windows Firewall rules in §2 are actually applied and active — a
  rule that references a binary path that doesn't match the real install
  location silently does nothing.
- `MAX_CONCURRENT_JOBS`/`MAX_QUEUE_SIZE`/rate-limit env vars (§3, and see
  `README.md` § Security & operational limits) are set appropriately for
  the VPS's actual CPU/bandwidth budget — the defaults were chosen for a
  small local/personal deployment, not sized against WebAiry's specific
  resource limits, which aren't known at time of writing.
