import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quick Extract",
  description: "Local-only media downloader. Downloads run on your machine via yt-dlp/ffmpeg.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
