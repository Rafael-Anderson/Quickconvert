# Deployment — Windows Server VPS

Runbook for deploying QuickExtract to a Windows Server VPS (target spec: 1
vCore, 2GB RAM). Written for the WebAiry VPS mentioned in
[SECURITY.md](SECURITY.md); the commands are generic Windows Server/Windows
Firewall and apply to any similarly-sized Windows VPS.

Every install below uses a direct binary download to `C:\tools`, not a
package manager — keeps the install auditable (one known URL per tool) and
avoids depending on winget/chocolatey being available on a minimal VPS image.

## 0. Prerequisites

- RDP access to the VPS (from your VPS provider's control panel).
- [Git for Windows](https://git-scm.com/download/win) installed (needed to
  `git clone` in step 3). If you'd rather not install Git, download the
  repo as a zip from GitHub instead and skip to step 3b.

## 1. RDP in

Connect with Remote Desktop Connection (`mstsc`) using the IP/credentials
from your VPS provider. All remaining steps run inside that session, in an
elevated PowerShell prompt (right-click Start → **Windows PowerShell (Admin)**).

## 2. Install Node.js 20 LTS (direct binary)

```powershell
New-Item -ItemType Directory -Force C:\tools | Out-Null

# Check https://nodejs.org/en/download for the current 20.x LTS version.
$nodeVersion = "v20.18.1"
$zipUrl = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip"
Invoke-WebRequest -Uri $zipUrl -OutFile "$env:TEMP\node.zip"
Expand-Archive -Path "$env:TEMP\node.zip" -DestinationPath C:\tools -Force
Rename-Item "C:\tools\node-$nodeVersion-win-x64" "C:\tools\node20"

[Environment]::SetEnvironmentVariable(
  "Path", "$([Environment]::GetEnvironmentVariable('Path','Machine'));C:\tools\node20",
  "Machine"
)
```

Close and reopen PowerShell (Admin) to pick up the new PATH, then verify:

```powershell
node -v   # v20.18.1
npm -v
```

## 3. Install yt-dlp and ffmpeg (direct binary, to C:\tools)

```powershell
# yt-dlp — single exe
Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" `
  -OutFile "C:\tools\yt-dlp.exe"

# ffmpeg — zip build, contains ffmpeg.exe/ffprobe.exe under a versioned \bin folder
Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" `
  -OutFile "$env:TEMP\ffmpeg.zip"
Expand-Archive -Path "$env:TEMP\ffmpeg.zip" -DestinationPath C:\tools -Force
$ffmpegDir = Get-ChildItem C:\tools -Directory -Filter "ffmpeg-*" | Select-Object -First 1
Rename-Item $ffmpegDir.FullName "C:\tools\ffmpeg"
```

Verify:

```powershell
C:\tools\yt-dlp.exe --version
C:\tools\ffmpeg\bin\ffmpeg.exe -version
```

These paths (`C:\tools\yt-dlp.exe`, `C:\tools\ffmpeg\bin`) are what you'll
point `YT_DLP_PATH`/`FFMPEG_LOCATION` at in step 6. Optional aria2c
(multi-threaded direct-link downloads — see [README.md](README.md)) follows
the same pattern if you want it:

```powershell
Invoke-WebRequest -Uri "https://github.com/aria2/aria2/releases/latest/download/aria2-1.37.0-win-64bit-build1.zip" `
  -OutFile "$env:TEMP\aria2.zip"
Expand-Archive -Path "$env:TEMP\aria2.zip" -DestinationPath C:\tools -Force
# rename the extracted folder's aria2c.exe location to C:\tools\aria2c.exe, or
# point ARIA2C_PATH at wherever it landed.
```

## 4. Clone the repo

```powershell
New-Item -ItemType Directory -Force C:\apps | Out-Null
git clone https://github.com/Rafael-Anderson/Quickconvert.git C:\apps\quickextract
cd C:\apps\quickextract
```

## 5. Install dependencies and build

```powershell
npm ci
npm run build
```

## 6. Set environment variables

Copy the example file and fill in real values:

```powershell
Copy-Item .env.production.example .env.production
notepad .env.production
```

At minimum, set `YT_DLP_PATH` and `FFMPEG_LOCATION` to the paths from step
3. See [.env.production.example](.env.production.example) for every
variable and what it does. Next.js loads `.env.production` automatically
when `NODE_ENV=production` (set by PM2 in step 7).

## 7. Start with PM2

```powershell
npm install -g pm2
pm2 start pm2.config.cjs --env production
pm2 save
```

Verify it's running and check logs:

```powershell
pm2 status
pm2 logs quickextract --lines 50
```

Open a browser on the VPS (or curl locally) to `http://localhost:3000` to
confirm the app responds before moving on to the firewall step.

**Survive reboots** (not in the original ask, but a PM2 process list is lost
on restart without this — flagging as a recommended addition):

```powershell
npm install -g pm2-windows-startup
pm2-startup install
pm2 save
```

## 8. Configure Windows Firewall

Two separate rule sets — apply both; they cover different things.

### 8a. Default-deny outbound (this VPS), allow only 80/443 + DNS

```powershell
# Allow inbound RDP explicitly before flipping the outbound default, so a
# misconfiguration here can't lock you out of the box (this only touches
# OUTBOUND; RDP is inbound-initiated and Windows Firewall's stateful
# tracking allows the reply traffic regardless of the outbound default —
# but confirm you still have console/provider access before proceeding).
New-NetFirewallRule -DisplayName "Allow inbound RDP" -Direction Inbound `
  -Protocol TCP -LocalPort 3389 -Action Allow

Set-NetFirewallProfile -Profile Domain,Public,Private -DefaultOutboundAction Block

New-NetFirewallRule -DisplayName "Allow outbound HTTPS" -Direction Outbound `
  -Protocol TCP -RemotePort 443 -Action Allow
New-NetFirewallRule -DisplayName "Allow outbound HTTP" -Direction Outbound `
  -Protocol TCP -RemotePort 80 -Action Allow
New-NetFirewallRule -DisplayName "Allow outbound DNS (UDP)" -Direction Outbound `
  -Protocol UDP -RemotePort 53 -Action Allow
New-NetFirewallRule -DisplayName "Allow outbound DNS (TCP)" -Direction Outbound `
  -Protocol TCP -RemotePort 53 -Action Allow
```

### 8b. Allow inbound to the app itself

The default-outbound-block above doesn't touch inbound traffic, so the app
still needs an inbound allow rule to be reachable:

```powershell
New-NetFirewallRule -DisplayName "Allow inbound QuickExtract" -Direction Inbound `
  -Protocol TCP -LocalPort 3000 -Action Allow
```

The app has **no authentication** (see [README.md](README.md) "Notes") — if
your VPS provider's firewall/security-group supports source-IP
restrictions, scope this rule (or the provider-level equivalent) to only
the IPs that should reach it, rather than `Any`.

### 8c. Subprocess egress guard (from SECURITY.md — apply this too)

The rules in 8a only block by port, not destination — `10.0.0.0/8:443` is
still allowed by the generic HTTPS rule above. [SECURITY.md](SECURITY.md)
§2 has the Windows Firewall commands that block `yt-dlp.exe`/`ffmpeg.exe`/
`aria2c.exe` specifically from reaching private/loopback/link-local ranges,
regardless of port — run those too, with the binary paths from step 3.
Windows Firewall block rules take precedence over allow rules on a match,
so this layers correctly on top of 8a.

## 9. Verify end-to-end

```powershell
pm2 status
pm2 logs quickextract --lines 20
```

From a machine outside the VPS, hit `http://<vps-ip>:3000` and run a real
download to confirm the full path (Node → yt-dlp → ffmpeg → response
stream) works with the production build and the firewall rules in place.

## Updating a deployed instance

```powershell
cd C:\apps\quickextract
git pull
npm ci
npm run build
pm2 restart quickextract
```
