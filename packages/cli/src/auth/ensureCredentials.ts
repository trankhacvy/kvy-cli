/**
 * "Give me usable credentials, signing the user in if needed" — the single entry point
 * commands should use instead of `readCredentials()` followed by a hard failure
 * (docs/auth-ux-overhaul-plan.md AX-1.3/AX-1.9).
 */
import type { Logger } from "../logger.js";
import { NO_TTY_CANNOT_SIGN_IN } from "../ui/messages.js";
import { type KvyCredentials, readCredentials } from "./credentials.js";
import { ensureLoggedIn } from "./login.js";

export type EnsureCredentialsResult =
  | { ok: true; credentials: KvyCredentials }
  | { ok: false; message: string };

export async function ensureCredentials(
  logger: Logger,
  homeDir: string,
): Promise<EnsureCredentialsResult> {
  const existing = readCredentials(homeDir);
  if (existing) return { ok: true, credentials: existing };

  const auth = await ensureLoggedIn(logger, homeDir);
  if (!auth.ok) return { ok: false, message: auth.message || NO_TTY_CANNOT_SIGN_IN };

  const fresh = readCredentials(homeDir);
  return fresh ? { ok: true, credentials: fresh } : { ok: false, message: NO_TTY_CANNOT_SIGN_IN };
}
