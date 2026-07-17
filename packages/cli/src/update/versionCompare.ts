/**
 * Minimal semver comparison — no dependency needed for the one thing
 * self-update actually asks: "is `latest` newer than `current`?" Handles
 * the two shapes every version string in this codebase actually takes
 * (`package.json`'s `"0.1.0"`, GitHub tags' `"v0.1.0"`), tolerating a
 * missing/malformed component as `0` rather than throwing — a corrupt or
 * unexpected version string on either side should never crash the update
 * check, just compare as sanely as possible (falcon-system-design.md §13,
 * plan.md §16 "4.3 Distribution & self-host": self-update must fail safe).
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function toInt(value: string | undefined): number {
  const n = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}

/** Strips a leading "v", drops any pre-release/build metadata (`-beta.1`, `+abc`). */
export function parseVersion(raw: string): ParsedVersion {
  const stripped = raw.trim().replace(/^v/i, "").split(/[-+]/)[0] ?? "";
  const [major, minor, patch] = stripped.split(".");
  return { major: toInt(major), minor: toInt(minor), patch: toInt(patch) };
}

/** `-1` if `a < b`, `0` if equal, `1` if `a > b`. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  return 0;
}

/** `true` iff `latest` is a strictly newer version than `current`. */
export function isNewerVersion(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0;
}
