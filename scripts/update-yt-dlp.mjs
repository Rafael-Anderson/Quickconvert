// Updates the yt-dlp binary this app is configured to use, and prints the
// before/after version so the change is visible in the log/scheduled-task
// output. Resolves the same YT_DLP_PATH (.env.local) the app itself uses,
// so this always updates the actual binary the server calls, not just
// whatever "yt-dlp" happens to resolve to on PATH by coincidence.
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function readYtDlpPathFromEnvLocal() {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return null;
  const match = readFileSync(envPath, "utf8").match(/^YT_DLP_PATH=(.+)$/m);
  return match ? match[1].trim() : null;
}

const bin = process.env.YT_DLP_PATH?.trim() || readYtDlpPathFromEnvLocal() || "yt-dlp";

function run(args) {
  // shell: false, args as a plain array — same invariant as the app itself
  // (see assertNotBatchShim/runChild in app/api/download/route.ts), even
  // though there's no user input here to worry about.
  return spawnSync(bin, args, { encoding: "utf8", shell: false });
}

const before = run(["--version"]);
if (before.error) {
  console.error(`Could not run "${bin} --version": ${before.error.message}`);
  console.error("Check YT_DLP_PATH in .env.local, or that yt-dlp is on PATH.");
  process.exit(1);
}
console.log(`Current version: ${before.stdout.trim()}`);

console.log(`Updating (${bin} -U)...`);
const update = spawnSync(bin, ["-U"], { stdio: "inherit", shell: false });
if (update.status !== 0) {
  console.error(
    `yt-dlp -U exited with code ${update.status}. If this is a pip install, self-update may be disabled — ` +
      `run "pip install --upgrade yt-dlp" instead.`
  );
  process.exit(update.status ?? 1);
}

const after = run(["--version"]);
console.log(`Now at: ${after.stdout?.trim() ?? "unknown"}`);
