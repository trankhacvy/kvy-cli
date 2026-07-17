/**
 * Path helpers for the managed adapter install directory (design §7.2:
 * "`adapters/` — managed ACP adapter installs — own npm prefix, pinned
 * exact versions, integrity-checked (§7.9)"). Kept as a standalone module
 * (no `home.ts` import) since every caller here already threads `homeDir`
 * explicitly — same seam pattern as `workspace/registry.ts`'s
 * `RegistryOptions.homeDir`.
 */
import path from "node:path";
import type { AdapterId } from "./manifest.js";
import { ADAPTER_MANIFEST } from "./manifest.js";

/** `~/.falcon/adapters/` — Falcon's own npm prefix for managed ACP adapter installs. */
export function adaptersDir(homeDir: string): string {
  return path.join(homeDir, "adapters");
}

/** The root `package.json` Falcon writes/maintains inside `adaptersDir()` — never hand-edited. */
export function adaptersPackageJsonPath(homeDir: string): string {
  return path.join(adaptersDir(homeDir), "package.json");
}

/** npm's own authoritative "what's actually installed" lockfile — the ground truth `verify.ts` reads against, not the hand-maintained root `package.json`/`package-lock.json`. */
export function installedLockPath(homeDir: string): string {
  return path.join(adaptersDir(homeDir), "node_modules", ".package-lock.json");
}

/** The installed package's own directory, e.g. `<adaptersDir>/node_modules/@scope/name`. */
export function adapterPackageDir(id: AdapterId, homeDir: string): string {
  const entry = ADAPTER_MANIFEST[id];
  return path.join(adaptersDir(homeDir), "node_modules", ...entry.packageName.split("/"));
}

/** The ACP server's stdio entrypoint — what gets spawned (design §7.9: `node <adapters>/node_modules/<pkg>/dist/index.js`). */
export function adapterEntryPath(id: AdapterId, homeDir: string): string {
  const entry = ADAPTER_MANIFEST[id];
  return path.join(adapterPackageDir(id, homeDir), entry.binEntry);
}
