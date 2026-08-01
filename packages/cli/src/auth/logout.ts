/**
 * `kvy auth logout` — clears the locally-stored credentials (port of
 * Happy's `handleAuthLogout` intent, minus its daemon-stop/confirmation-
 * prompt steps — daemon lifecycle is out of scope for this command, and a
 * destructive-but-recoverable local action doesn't need an interactive
 * confirmation the way Happy's original full-directory `rmSync` did).
 */
import type { Logger } from "../logger.js";
import { clearCredentials, readCredentials } from "./credentials.js";

export function runAuthLogout(logger: Logger): number {
  if (!readCredentials()) {
    process.stdout.write("Not logged in.\n");
    return 0;
  }

  clearCredentials();
  logger.info("auth logout: credentials cleared");
  process.stdout.write("Logged out.\n");
  return 0;
}
