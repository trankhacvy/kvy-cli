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
