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
