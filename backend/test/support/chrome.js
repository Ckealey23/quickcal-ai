import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const chromePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((candidate) => candidate && existsSync(candidate));

// Loads `html` in headless Chrome and returns the final DOM, or writes a
// screenshot when `screenshot` names a PNG path.
export async function runPage(html, options) {
  const settings = options || {};
  const directory = mkdtempSync(path.join(tmpdir(), "quickcal-page-"));
  const profile = mkdtempSync(path.join(tmpdir(), "quickcal-chrome-"));
  const page = path.join(directory, "page.html");
  writeFileSync(page, html);
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
    "--hide-scrollbars",
    "--user-data-dir=" + profile,
    "--allow-file-access-from-files",
    "--window-size=" + (settings.size || "1100,760"),
    "--virtual-time-budget=" + (settings.budget || 6000),
  ];
  if (settings.screenshot) args.push("--screenshot=" + settings.screenshot);
  else args.push("--dump-dom");
  if (settings.reducedMotion) args.push("--force-prefers-reduced-motion");
  args.push(pathToFileURL(page).href);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(chromePath, args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
}
