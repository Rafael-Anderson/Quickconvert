"use client";

import { useMemo, useRef, useState } from "react";
import { GridPattern } from "@/components/ui/grid-pattern";

type Kind = "audio" | "video";
type Format = "mp3" | "m4a" | "wav" | "flac" | "opus" | "mp4" | "webm" | "mkv" | "mov";

const CONTAINERS_BY_KIND: Record<Kind, { value: Format; label: string }[]> = {
  audio: [
    { value: "mp3", label: "MP3" },
    { value: "m4a", label: "M4A (AAC)" },
    { value: "opus", label: "Opus" },
    { value: "flac", label: "FLAC (lossless)" },
    { value: "wav", label: "WAV (lossless)" },
  ],
  video: [
    { value: "mp4", label: "MP4" },
    { value: "webm", label: "WebM" },
    { value: "mkv", label: "MKV" },
    { value: "mov", label: "MOV" },
  ],
};

const QUALITY_OPTIONS: Record<Format, { value: string; label: string }[]> = {
  mp3: [
    { value: "320", label: "320 kbps" },
    { value: "192", label: "192 kbps" },
    { value: "128", label: "128 kbps" },
  ],
  m4a: [
    { value: "320", label: "320 kbps" },
    { value: "192", label: "192 kbps" },
    { value: "128", label: "128 kbps" },
  ],
  opus: [
    { value: "320", label: "320 kbps" },
    { value: "192", label: "192 kbps" },
    { value: "128", label: "128 kbps" },
  ],
  flac: [{ value: "best", label: "Lossless" }],
  wav: [{ value: "best", label: "Lossless" }],
  mp4: [
    { value: "best", label: "Best available" },
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
  ],
  webm: [
    { value: "best", label: "Best available" },
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
  ],
  mkv: [
    { value: "best", label: "Best available" },
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
  ],
  mov: [
    { value: "best", label: "Best available" },
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
  ],
};

function kindOf(format: Format): Kind {
  return format === "mp4" || format === "webm" || format === "mkv" || format === "mov"
    ? "video"
    : "audio";
}

// Maps the backend's X-Download-Source header to a short debugging label
// shown alongside the success message.
const SOURCE_LABELS: Record<string, string> = {
  "yt-dlp": "yt-dlp",
  "direct-link": "direct link",
  "html-scrape": "page scrape",
};

function parseFilename(disposition: string | null): string | null {
  if (!disposition) return null;
  // Prefer RFC 5987 filename* (UTF-8), fall back to plain filename.
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^"]+)"?/i.exec(disposition);
  return plain ? plain[1] : null;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<Kind>("video");
  const [format, setFormat] = useState<Format>("mp4");
  const [quality, setQuality] = useState<string>("best");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const trickleRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const containerOptions = useMemo(() => CONTAINERS_BY_KIND[kind], [kind]);
  const qualityOptions = useMemo(() => QUALITY_OPTIONS[format], [format]);

  function onKindChange(next: Kind) {
    setKind(next);
    const firstFormat = CONTAINERS_BY_KIND[next][0].value;
    setFormat(firstFormat);
    setQuality(QUALITY_OPTIONS[firstFormat][0].value);
  }

  function onFormatChange(next: Format) {
    setFormat(next);
    setQuality(QUALITY_OPTIONS[next][0].value);
  }

  function stopTrickle() {
    if (trickleRef.current) {
      clearInterval(trickleRef.current);
      trickleRef.current = null;
    }
  }

  // Wraps the download call in XHR (instead of fetch) purely so we get
  // upload/download byte progress events to drive the progress bar; the
  // request/response contract with /api/download is unchanged.
  function postDownload(payload: string): Promise<{
    blob: Blob;
    status: number;
    getHeader: (name: string) => string | null;
  }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/download");
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.responseType = "blob";

      let sawDownloadProgress = false;

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          setProgress((p) => Math.max(p, (event.loaded / event.total) * 30));
        }
      };

      xhr.upload.onloadend = () => {
        setProgress((p) => Math.max(p, 30));
        // Heuristic trickle for the download phase in case the response
        // doesn't expose a usable length — replaced by real progress below
        // the moment a real xhr.onprogress event arrives.
        trickleRef.current = setInterval(() => {
          if (sawDownloadProgress) return;
          setProgress((p) => (p < 90 ? p + (90 - p) * 0.1 : p));
        }, 250);
      };

      xhr.onprogress = (event) => {
        if (event.lengthComputable) {
          sawDownloadProgress = true;
          setProgress(30 + (event.loaded / event.total) * 70);
        }
      };

      xhr.onload = () => {
        stopTrickle();
        resolve({
          blob: xhr.response as Blob,
          status: xhr.status,
          getHeader: (name) => xhr.getResponseHeader(name),
        });
      };

      xhr.onerror = () => {
        stopTrickle();
        reject(new Error("Network error. Try again."));
      };

      xhr.send(payload);
    });
  }

  async function handleDownload(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!url.trim()) {
      setError("Please enter a URL.");
      return;
    }

    setLoading(true);
    setProgress(0);
    try {
      const { blob, status, getHeader } = await postDownload(
        JSON.stringify({ url: url.trim(), format, quality })
      );
      const ok = status >= 200 && status < 300;

      if (!ok) {
        let message = `Request failed (${status}).`;
        try {
          // Structured errors (e.g. { error: "unsupported_site", message })
          // carry the human-readable text in `message`; older responses put
          // it directly in `error`.
          const data = JSON.parse(await blob.text());
          if (data?.message) message = data.message;
          else if (data?.error) message = data.error;
        } catch {
          /* non-JSON error body */
        }
        setError(message);
        return;
      }

      const filename =
        parseFilename(getHeader("Content-Disposition")) || `download.${format}`;
      const sourceLabel = SOURCE_LABELS[getHeader("X-Download-Source") ?? ""];
      const qualityLabel = getHeader("X-Download-Quality");

      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);

      const details = [
        sourceLabel ? `via ${sourceLabel}` : null,
        qualityLabel && qualityLabel !== "unknown" ? qualityLabel : null,
      ]
        .filter(Boolean)
        .join(", ");
      setSuccess(`Saved "${filename}"${details ? ` (${details})` : ""}.`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong. Try again."
      );
    } finally {
      stopTrickle();
      setLoading(false);
      setProgress(100);
      setTimeout(() => setProgress(0), 350);
    }
  }

  return (
    <div className="page-wrapper relative overflow-hidden">
      <GridPattern />
      <main className="card relative overflow-hidden">
        {(loading || progress > 0) && (
          <div
            className="absolute left-0 top-0 h-1 w-full bg-[var(--border)]"
            role="progressbar"
            aria-label="Download progress"
            aria-valuenow={Math.round(progress)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-[var(--accent)] transition-all duration-150 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
        <div className="flex items-center gap-6">
          {/* alt="" (decorative): the adjacent <h1> already names the app,
              so alt text here would double-announce "Quick Extract". */}
          <img
            src="/logo.png"
            alt=""
            className="h-32 w-32 object-contain mix-blend-lighten shrink-0"
          />
          <div className="flex-1 min-w-0 max-w-none">
            <h1 className="title">Quick Extract</h1>
            <p className="subtitle">Local-only. Downloads run on your machine via yt-dlp/ffmpeg.</p>
          </div>
        </div>

        <form onSubmit={handleDownload}>
          <div className="field">
            <label className="label" htmlFor="url">
              URL
            </label>
            <input
              id="url"
              className="input"
              type="text"
              inputMode="url"
              placeholder="https://www.youtube.com/watch?v=..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
            />
          </div>

          <div className="field">
            <span className="label" id="kind-label">Kind</span>
            <div className="radio-group" role="radiogroup" aria-labelledby="kind-label">
              <label className={`radio ${kind === "video" ? "active" : ""}`}>
                <input
                  type="radio"
                  name="kind"
                  value="video"
                  checked={kind === "video"}
                  onChange={() => onKindChange("video")}
                  disabled={loading}
                />
                Video
              </label>
              <label className={`radio ${kind === "audio" ? "active" : ""}`}>
                <input
                  type="radio"
                  name="kind"
                  value="audio"
                  checked={kind === "audio"}
                  onChange={() => onKindChange("audio")}
                  disabled={loading}
                />
                Audio
              </label>
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor="container">
              Format
            </label>
            <select
              id="container"
              className="select"
              value={format}
              onChange={(e) => onFormatChange(e.target.value as Format)}
              disabled={loading}
            >
              {containerOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="label" htmlFor="quality">
              Quality
            </label>
            <select
              id="quality"
              className="select"
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
              disabled={loading}
            >
              {qualityOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <button className="button" type="submit" disabled={loading}>
            {loading ? (
              <>
                <span className="spinner" />
                Downloading…
              </>
            ) : (
              "Download"
            )}
          </button>
        </form>

        {/* role="alert" = assertive live region; role="status" = polite.
            Both announce on mount even though they're conditionally rendered. */}
        {error && <div className="alert error" role="alert">{error}</div>}
        {success && <div className="alert success" role="status">{success}</div>}

        {loading && (
          <p className="hint" role="status">
            This can take a while for long videos — keep this tab open.
          </p>
        )}
      </main>
    </div>
  );
}
