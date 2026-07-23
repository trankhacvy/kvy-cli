/**
 * `~/.falcon/access.key` persistence (falcon-plan.md §2.1: "`access.key`:
 * `{token, masterSecretOrContentBundle}` base64 JSON, chmod 600"). Port of
 * Happy's `persistence.ts` credential read/write, adapted to Falcon's single
 * always-present masterSecret shape — Falcon has no legacy/dataKey split to
 * carry forward, so unlike Happy's `Credentials` union this is one flat shape.
 *
 * issue-4-plan.md §6.5/§6.6: the bare 1h `token` field is replaced by a persistent
 * `refreshToken` — the whole point of the reissue is that a stored *access* token goes
 * stale in an hour (or 15m post-Phase-6) with no way back; a refresh token is what lets
 * `auth/tokenProvider.ts` mint fresh access tokens indefinitely (up to its own 60-day
 * absolute lifetime, §4.6) without another `falcon auth login`.
 *
 * **Deviation from the plan's illustrative `keyMaterial` discriminated union** (PIN /
 * device-keychain / plaintext-fallback wrapping, §6.5): not implemented here. This file
 * still stores `masterSecretOrContentBundle` as a bare base64 string, same at-rest
 * custody as before (0600 file permissions only) — the PIN-wrap and OS-keychain
 * device-key wrapping described in §6.5 would layer a `PinWrapped`/`DeviceWrapped`
 * encoding on top of this field, but that's a real scope cut for this pass, recorded in
 * docs/issue-4-plan.md's Phase 5 checklist. The plan itself is candid that this
 * particular improvement "delivers little at-rest benefit on daemon boxes" anyway
 * (§6.5) — the refresh-token fix above is the part that actually closes known-issues.md
 * #4's "daemon never re-authenticates" gap.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveHomeDir } from "../home.js";

const CredentialsSchema = z.object({
  refreshToken: z.string().min(1),
  // base64-encoded masterSecret (or a content-key bundle for machines paired
  // with reduced custody — plan.md §2.1's "masterSecretOrContentBundle").
  // Opaque to this module either way; only the auth flows care what's inside.
  masterSecretOrContentBundle: z.string().min(1),
});

export type FalconCredentials = z.infer<typeof CredentialsSchema>;

// Owner read/write only — this file holds the account's master secret.
const CREDENTIALS_FILE_MODE = 0o600;

export function credentialsPath(homeDir: string = resolveHomeDir()): string {
  return path.join(homeDir, "access.key");
}

/**
 * Reads and validates `~/.falcon/access.key`. Never throws (design principle
 * #1) — a missing, unreadable, or malformed file is just "not logged in",
 * not an exceptional condition callers need to catch.
 */
export function readCredentials(homeDir: string = resolveHomeDir()): FalconCredentials | null {
  const file = credentialsPath(homeDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = CredentialsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Writes `~/.falcon/access.key`, chmod 0600 (falcon-plan.md §2.1). */
export function writeCredentials(
  credentials: FalconCredentials,
  homeDir: string = resolveHomeDir(),
): void {
  if (!existsSync(homeDir)) mkdirSync(homeDir, { recursive: true });
  const file = credentialsPath(homeDir);
  writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { mode: CREDENTIALS_FILE_MODE });
  // `writeFileSync`'s `mode` option only applies when the file is *created*;
  // chmod explicitly too so re-login over an existing file always ends up
  // 0600 regardless of what it was before (e.g. a stale looser-permissioned
  // file from a manual edit).
  chmodSync(file, CREDENTIALS_FILE_MODE);
}

export function clearCredentials(homeDir: string = resolveHomeDir()): void {
  const file = credentialsPath(homeDir);
  if (existsSync(file)) unlinkSync(file);
}
