import open from "open";

export async function openBrowser(url: string): Promise<boolean> {
  // Headless environments (CI, devcontainers without a display, piped stdout) can't open a browser.
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
