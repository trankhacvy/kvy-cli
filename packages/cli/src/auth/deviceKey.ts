/**
 * OS-keychain device-key wrapping for the CLI's reduced-custody / daemon default
 * (issue-4-plan.md §6.1/§6.5): wraps a secret (a reduced-custody content bundle for the
 * daemon, or a full masterSecret for `falcon auth login` on a box with no interactive
 * PIN entry) under a random AES-256 key that itself lives in the macOS Keychain rather
 * than inside `~/.falcon/access.key` alongside the wrapped blob.
 *
 * The plan is candid that this "delivers little at-rest benefit on daemon boxes
 * anyway" (§6.5) — a root/owner compromise that can read `access.key` can usually also
 * read the Keychain or this fallback file — but it does raise the bar against the
 * narrower threat of "another process/user on this machine reads `access.key` off
 * disk" (e.g. a backup, a misconfigured shared box), and keeps the wrapping key out of
 * the file that a `git`/dotfiles-sync tool might otherwise scoop up.
 *
 * Only macOS Keychain is implemented (via the `security` CLI, same tool
 * `provider/claudeAuth.ts` already shells out to for presence-checking Claude Code's
 * own credentials). Every other platform (Linux, Windows, or macOS with `security`
 * unavailable) falls back to a plaintext device-key file, 0600 — explicitly documented
 * here and in `credentials.ts`, not a silent downgrade.
 */
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

export interface DeviceWrapped {
  v: 1;
  /** AES-GCM nonce, base64. */
  nonce: string;
  /** AES-GCM ciphertext with the 16-byte auth tag appended, base64. */
  ct: string;
}

const KEYCHAIN_SERVICE = "Falcon-device-key";
const FALLBACK_KEY_FILE = "device.key";
const DEVICE_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const FALLBACK_KEY_FILE_MODE = 0o600;

function fallbackKeyPath(homeDir: string): string {
  return path.join(homeDir, FALLBACK_KEY_FILE);
}

function defaultReadMacKeychainKey(): Buffer | null {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const key = Buffer.from(out.trim(), "base64");
    return key.length === DEVICE_KEY_BYTES ? key : null;
  } catch {
    // Not found, Keychain locked, or `security` unavailable.
    return null;
  }
}

function defaultWriteMacKeychainKey(key: Buffer): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        userInfo().username,
        "-w",
        key.toString("base64"),
        "-U", // update in place if an entry already exists, rather than erroring
      ],
      { stdio: ["ignore", "ignore", "ignore"], timeout: 3000 },
    );
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
  /** Overrides the macOS Keychain read. Defaults to a real `security` CLI call — tests
   * inject a fake instead of touching the host machine's actual Keychain. */
  readKeychainKey?: () => Buffer | null;
  /** Overrides the macOS Keychain write; returns whether it succeeded. */
  writeKeychainKey?: (key: Buffer) => boolean;
}

/**
 * Loads this machine's device key, creating and persisting one on first use.
 * Keychain-first (macOS): only falls back to (and creates) the plaintext file when the
 * Keychain is unavailable or the `security` CLI itself fails — never both at once, so a
 * key wrapped one way is always found the same way later.
 */
function loadOrCreateDeviceKey(homeDir: string, deps: DeviceKeyDeps): Buffer {
  const readKeychainKey = deps.readKeychainKey ?? defaultReadMacKeychainKey;
  const writeKeychainKey = deps.writeKeychainKey ?? defaultWriteMacKeychainKey;

  const fromKeychain = readKeychainKey();
  if (fromKeychain) return fromKeychain;

  const fromFallback = readFallbackKey(homeDir);
  if (fromFallback) return fromFallback;

  const key = randomBytes(DEVICE_KEY_BYTES);
  if (writeKeychainKey(key)) return key;
  writeFallbackKey(homeDir, key);
  return key;
}

/** Wrap `secret` under this machine's device key (Keychain-backed where available). */
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
 * device key or a corrupt blob (same never-throw contract as `@falcon/crypto`'s
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
