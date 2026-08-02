import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PinWrapped } from "@kvy/crypto";
import { z } from "zod";
import { resolveHomeDir } from "../home.js";

const PinWrappedSchema = z.object({
  v: z.literal(1),
  kdf: z.literal("argon2id"),
  salt: z.string(),
  nonce: z.string(),
  ct: z.string(),
});

const DeviceWrappedSchema = z.object({
  v: z.literal(1),
  nonce: z.string(),
  ct: z.string(),
});

const KeyMaterialSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("pin"), wrapped: PinWrappedSchema }),
  z.object({ mode: z.literal("device"), wrapped: DeviceWrappedSchema }),
  z.object({ mode: z.literal("plaintext-fallback"), bundle: z.string().min(1) }),
]);

export type KeyMaterial = z.infer<typeof KeyMaterialSchema>;

const CredentialsSchema = z.object({
  refreshToken: z.string().min(1),
  keyMaterial: KeyMaterialSchema,
});

export type KvyCredentials = z.infer<typeof CredentialsSchema>;

// Owner read/write only — this file holds (at minimum, wrapped) the account's master
// secret.
const CREDENTIALS_FILE_MODE = 0o600;

export function credentialsPath(homeDir: string = resolveHomeDir()): string {
  return path.join(homeDir, "access.key");
}

/**
 * Reads and validates `~/.kvy/access.key`. Never throws — a missing, unreadable, or
 * malformed file is just "not logged in", not an exceptional condition callers need to
 * catch.
 */
export function readCredentials(homeDir: string = resolveHomeDir()): KvyCredentials | null {
  const file = credentialsPath(homeDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = CredentialsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Writes `~/.kvy/access.key`, chmod 0600. */
export function writeCredentials(
  credentials: KvyCredentials,
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

export type { PinWrapped };
