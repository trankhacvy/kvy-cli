/**
 * Verify-before-spawn checks (design §7.9: "Post-install integrity check
 * against the manifest hash; a mismatch refuses to spawn"). Reads npm's own
 * `node_modules/.package-lock.json` — the hidden, auto-maintained lockfile
 * npm writes after every `install`/`ci` describing exactly what's on disk
 * (verified empirically: `version/resolved/integrity` per package, same
 * shape as the project-root `package-lock.json`) — rather than re-hashing
 * installed files ourselves. This is real, load-bearing verification: it
 * catches a corrupted/tampered/downgraded install, a manually-deleted
 * `node_modules`, or a manifest bump that hasn't been installed yet, without
 * ever needing network access.
 *
 * Deliberately never throws: every caller (the installer's post-install
 * check, `falcon doctor`, and Phase 2.1's `acpConnection.ts` spawn path)
 * needs a plain "is this usable, and if not, why" answer rather than a
 * try/catch — same "no silent failures, no thrown surprises" shape as
 * `codexProviderAdapter.ts`'s `detectCodex`.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AdapterId } from "./manifest.js";
import { ADAPTER_MANIFEST } from "./manifest.js";
import { adapterEntryPath, installedLockPath } from "./paths.js";

export type AdapterVerifyFailureReason =
  | "not-installed"
  | "version-mismatch"
  | "integrity-mismatch"
  | "entry-missing";

export type AdapterVerifyResult =
  | { ok: true; entryPath: string; version: string }
  | { ok: false; reason: AdapterVerifyFailureReason; detail?: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readInstalledLock(homeDir: string): Promise<Record<string, unknown> | null> {
  const lockPath = installedLockPath(homeDir);
  if (!existsSync(lockPath)) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Verifies that adapter `id` is installed at `homeDir` with exactly the
 * pinned version and integrity hash from `ADAPTER_MANIFEST`, and that its
 * spawn entrypoint actually exists on disk.
 */
export async function verifyAdapterInstall(
  id: AdapterId,
  homeDir: string,
): Promise<AdapterVerifyResult> {
  const entry = ADAPTER_MANIFEST[id];
  const lock = await readInstalledLock(homeDir);
  if (!lock) return { ok: false, reason: "not-installed" };

  const packages = isPlainObject(lock.packages) ? lock.packages : {};
  const pkgKey = `node_modules/${entry.packageName}`;
  const installed = packages[pkgKey];
  if (!isPlainObject(installed)) return { ok: false, reason: "not-installed" };

  const installedVersion = typeof installed.version === "string" ? installed.version : undefined;
  if (installedVersion !== entry.version) {
    return {
      ok: false,
      reason: "version-mismatch",
      detail: `installed ${installedVersion ?? "unknown"}, pinned ${entry.version}`,
    };
  }

  const installedIntegrity =
    typeof installed.integrity === "string" ? installed.integrity : undefined;
  if (installedIntegrity !== entry.integrity) {
    return {
      ok: false,
      reason: "integrity-mismatch",
      detail: "installed package integrity does not match the pinned manifest",
    };
  }

  const entryPath = adapterEntryPath(id, homeDir);
  if (!existsSync(entryPath)) {
    return { ok: false, reason: "entry-missing", detail: entryPath };
  }

  return { ok: true, entryPath, version: installedVersion };
}
