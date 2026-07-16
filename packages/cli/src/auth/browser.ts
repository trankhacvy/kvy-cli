/**
 * Best-effort automatic browser launch — port of Happy's
 * `happy-cli/src/utils/browser.ts`. Never throws and never blocks the
 * pairing flow: a failed or skipped launch just means the caller falls back
 * to printing the URL (and a QR code) for the user to open manually.
 */
import open from "open";

export async function openBrowser(url: string): Promise<boolean> {
  // Headless environments (CI, devcontainers without a display, piped
  // stdout) can't usefully open a browser — same detection Happy uses.
  if (!process.stdout.isTTY || process.env.CI || process.env.HEADLESS) {
    return false;
  }
  try {
    await open(url);
    return true;
  } catch {
    return false;
  }
}
