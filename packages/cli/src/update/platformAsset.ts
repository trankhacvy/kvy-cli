/**
 * Maps the running process's platform/arch to the exact asset-name
 * convention `scripts/build-binaries.sh` publishes (`kvy-$platform-$arch`
 * — see that script and `scripts/install.sh`'s matching `uname`-based
 * detection). Kept as its own tiny pure function rather than duplicated
 * inline so `applyUpdate.ts` and its tests share one source of truth for
 * "which binary does this machine get".
 */

export interface PlatformAsset {
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
  /** e.g. "kvy-darwin-arm64" — matches `build-binaries.sh`'s `TARGETS` suffixes exactly. */
  assetName: string;
}

/**
 * `null` for any combination `scripts/build-binaries.sh` doesn't publish a
 * binary for (Windows, linux-arm64 — same gap `install.sh` already
 * documents) — callers fall back to the npm-install path in that case.
 */
export function detectPlatformAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformAsset | null {
  if (platform !== "darwin" && platform !== "linux") return null;
  if (arch !== "arm64" && arch !== "x64") return null;
  if (platform === "linux" && arch === "arm64") return null; // no linux-arm64 binary published yet

  return { platform, arch, assetName: `kvy-${platform}-${arch}` };
}
