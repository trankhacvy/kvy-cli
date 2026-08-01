/**
 * Adapter manager barrel (design §7.9, plan.md §16 "Phase 2.0 —
 * foundation: Adapter manager"). Standalone module — no dependency on the
 * claim store or `@kvy/wire` changes landing alongside it in the same
 * phase.
 */

export type { AdapterHealth } from "./health.js";
export { checkAdapterHealth, checkAllAdaptersHealth } from "./health.js";
export type {
  AdapterInstallDeps,
  AdapterInstallOutcome,
  AdapterInstallStatus,
  NpmExec,
} from "./install.js";
export {
  AdapterInstallError,
  AdapterIntegrityError,
  installAdapter,
  installAllAdapters,
  runNpm,
} from "./install.js";
export type { AdapterId, AdapterManifestEntry } from "./manifest.js";
export { ADAPTER_IDS, ADAPTER_MANIFEST } from "./manifest.js";
export {
  adapterEntryPath,
  adapterPackageDir,
  adaptersDir,
  adaptersPackageJsonPath,
  installedLockPath,
} from "./paths.js";
export type { AdapterSpawnSpec, ResolveAdapterSpawnResult } from "./spawn.js";
export { resolveAdapterSpawn } from "./spawn.js";
export type { AdapterVerifyFailureReason, AdapterVerifyResult } from "./verify.js";
export { verifyAdapterInstall } from "./verify.js";
