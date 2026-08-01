/**
 * `kvy doctor` adapter-health checks (design §7.9: "`kvy doctor`
 * reports adapter presence/version/integrity"). Kept as its own module
 * rather than inlined into `daemon/doctor.ts` so it's independently
 * testable and reusable from the `kvy adapters` command / Phase 2.1's
 * `acpConnection.ts` without a `daemon/` import — this module has zero
 * dependency on the daemon.
 */
import type { AdapterId } from "./manifest.js";
import { ADAPTER_MANIFEST } from "./manifest.js";
import type { AdapterVerifyFailureReason } from "./verify.js";
import { verifyAdapterInstall } from "./verify.js";

export interface AdapterHealth {
  id: AdapterId;
  label: string;
  packageName: string;
  pinnedVersion: string;
  status: "ok" | AdapterVerifyFailureReason;
  detail?: string;
}

export async function checkAdapterHealth(id: AdapterId, homeDir: string): Promise<AdapterHealth> {
  const entry = ADAPTER_MANIFEST[id];
  const result = await verifyAdapterInstall(id, homeDir);

  const base = {
    id,
    label: entry.label,
    packageName: entry.packageName,
    pinnedVersion: entry.version,
  };

  if (result.ok) return { ...base, status: "ok" };
  return { ...base, status: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
}

/** Checks every adapter in `ADAPTER_MANIFEST`, in manifest order. */
export async function checkAllAdaptersHealth(homeDir: string): Promise<AdapterHealth[]> {
  const ids = Object.keys(ADAPTER_MANIFEST) as AdapterId[];
  return Promise.all(ids.map((id) => checkAdapterHealth(id, homeDir)));
}
