/**
 * Cross-platform OS-vault device-key wrapping for the CLI's default at-rest custody
 * (issue-4-plan.md §6.1/§6.5, revised): wraps a secret (the masterSecret for
 * `kvy auth login`, or a reduced-custody content bundle for the daemon) under a
 * random AES-256 key that itself lives in the OS's own credential vault — macOS
 * Keychain, Windows Credential Manager, or the Linux Secret Service — rather than
 * inside `~/.kvy/access.key` alongside the wrapped blob.
 *
 * The plan is candid that this "delivers little at-rest benefit on daemon boxes
 * anyway" (§6.5) — a root/owner compromise that can read `access.key` can usually also
 * read the vault or this fallback file — but it does raise the bar against the
 * narrower threat of "another process/user on this machine reads `access.key` off
 * disk" (e.g. a backup, a misconfigured shared box), and keeps the wrapping key out of
 * the file that a `git`/dotfiles-sync tool might otherwise scoop up.
 *
 * Backed by `@napi-rs/keyring` (real OS vault on macOS/Windows/Linux). If the vault is
 * unavailable on this machine (no Secret Service daemon running, locked, etc.), falls
 * back to a plaintext device-key file, 0600 — explicitly documented here and in
 * `credentials.ts`, not a silent downgrade.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Entry } from "@napi-rs/keyring";

export interface DeviceWrapped {
  v: 1;
  /** AES-GCM nonce, base64. */
  nonce: string;
  /** AES-GCM ciphertext with the 16-byte auth tag appended, base64. */
  ct: string;
}

const KEYRING_SERVICE = "Kvy-device-key";
const KEYRING_ACCOUNT = "kvy";
const FALLBACK_KEY_FILE = "device.key";
const DEVICE_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const FALLBACK_KEY_FILE_MODE = 0o600;

function fallbackKeyPath(homeDir: string): string {
  return path.join(homeDir, FALLBACK_KEY_FILE);
}

function defaultReadKeyringKey(): Buffer | null {
  try {
    const entry = new Entry(KEYRING_SERVICE, KEYRING_ACCOUNT);
    const stored = entry.getPassword();
    if (!stored) return null;
    const key = Buffer.from(stored, "base64");
    return key.length === DEVICE_KEY_BYTES ? key : null;
  } catch {
    // Not found, vault locked/unavailable, or no vault daemon on this machine.
    return null;
  }
}

function defaultWriteKeyringKey(key: Buffer): boolean {
  try {
    const entry = new Entry(KEYRING_SERVICE, KEYRING_ACCOUNT);
    entry.setPassword(key.toString("base64"));
    return true;
  } catch {
    return false;
  }
}

function readFallbackKey(homeDir: string): Buffer | null {
  const file = fallbackKeyPath(homeDir);
  if (!existsSync(file)) return null;
  try {
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    return key.length === DEVICE_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

function writeFallbackKey(homeDir: string, key: Buffer): void {
  if (!existsSync(homeDir)) mkdirSync(homeDir, { recursive: true });
  const file = fallbackKeyPath(homeDir);
  writeFileSync(file, `${key.toString("base64")}\n`, { mode: FALLBACK_KEY_FILE_MODE });
  chmodSync(file, FALLBACK_KEY_FILE_MODE);
}

export interface DeviceKeyDeps {
  /** Overrides the OS vault read. Defaults to a real `@napi-rs/keyring` call — tests
   * inject a fake instead of touching the host machine's actual vault. */
  readKeychainKey?: () => Buffer | null;
  /** Overrides the OS vault write; returns whether it succeeded. */
  writeKeychainKey?: (key: Buffer) => boolean;
}

/**
 * Loads this machine's device key, creating and persisting one on first use.
 * File-first: checks the plaintext fallback file before the OS vault, so a blocking
 * Keychain permission dialog (macOS) never stalls the process when the file already
 * exists. Falls back to the vault only when no file is present.
 */
function loadOrCreateDeviceKey(homeDir: string, deps: DeviceKeyDeps): Buffer {
  const readKeyringKey = deps.readKeychainKey ?? defaultReadKeyringKey;
  const writeKeyringKey = deps.writeKeychainKey ?? defaultWriteKeyringKey;

  const fromFallback = readFallbackKey(homeDir);
  if (fromFallback) return fromFallback;

  const fromKeyring = readKeyringKey();
  if (fromKeyring) return fromKeyring;

  const key = randomBytes(DEVICE_KEY_BYTES);
  if (writeKeyringKey(key)) return key;
  writeFallbackKey(homeDir, key);
  return key;
}

/** Wrap `secret` under this machine's device key (OS-vault-backed where available). */
export function wrapWithDeviceKey(
  secret: Uint8Array,
  homeDir: string,
  deps: DeviceKeyDeps = {},
): DeviceWrapped {
  const key = loadOrCreateDeviceKey(homeDir, deps);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    nonce: nonce.toString("base64"),
    ct: Buffer.concat([ciphertext, tag]).toString("base64"),
  };
}

/** Inverse of `wrapWithDeviceKey`. Never throws — returns `null` on a missing/rotated
 * device key or a corrupt blob (same never-throw contract as `@kvy/crypto`'s
 * `unwrapWithPin`). */
export function unwrapWithDeviceKey(
  wrapped: DeviceWrapped,
  homeDir: string,
  deps: DeviceKeyDeps = {},
): Uint8Array | null {
  if (wrapped.v !== 1) return null;
  try {
    const key = loadOrCreateDeviceKey(homeDir, deps);
    const nonce = Buffer.from(wrapped.nonce, "base64");
    const ctAndTag = Buffer.from(wrapped.ct, "base64");
    if (ctAndTag.length < 16) return null;
    const tag = ctAndTag.subarray(ctAndTag.length - 16);
    const ciphertext = ctAndTag.subarray(0, ctAndTag.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    return null;
  }
}
