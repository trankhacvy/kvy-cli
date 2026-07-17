/**
 * Verify-before-spawn resolution (design §7.9). This is the seam Phase
 * 2.1's `acpConnection.ts` spawns adapters through: it never spawns
 * `node <entrypoint>` directly off `paths.ts`, it calls
 * `resolveAdapterSpawn()` and only spawns on an `ok: true` result — the
 * same verification `verify.ts` runs (version + integrity against
 * `ADAPTER_MANIFEST`), returned already shaped as a ready-to-use
 * `{command, args}` pair.
 */
import type { AdapterId } from "./manifest.js";
import type { AdapterVerifyFailureReason } from "./verify.js";
import { verifyAdapterInstall } from "./verify.js";

export interface AdapterSpawnSpec {
  /** Always the running Node's own executable — the adapter is a plain Node ESM/CJS entrypoint, never made independently executable. */
  command: string;
  args: string[];
}

export type ResolveAdapterSpawnResult =
  | { ok: true; spec: AdapterSpawnSpec }
  | { ok: false; reason: AdapterVerifyFailureReason; detail?: string };

/**
 * Resolves adapter `id`'s spawn command, refusing (rather than returning a
 * best-effort guess) when the install is missing, mismatched, or corrupt.
 * `execPath` defaults to `process.execPath` — injectable for tests.
 */
export async function resolveAdapterSpawn(
  id: AdapterId,
  homeDir: string,
  execPath: string = process.execPath,
): Promise<ResolveAdapterSpawnResult> {
  const result = await verifyAdapterInstall(id, homeDir);
  if (!result.ok) return result;
  return { ok: true, spec: { command: execPath, args: [result.entryPath] } };
}
