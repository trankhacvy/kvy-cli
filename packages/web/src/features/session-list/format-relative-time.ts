const UNITS: Array<[label: string, ms: number]> = [
  ["y", 365 * 24 * 60 * 60 * 1000],
  ["mo", 30 * 24 * 60 * 60 * 1000],
  ["d", 24 * 60 * 60 * 1000],
  ["h", 60 * 60 * 1000],
  ["m", 60 * 1000],
];

/** Compact relative time for a session card's timestamp ("5m", "2h", "3d").
 * Deliberately terse — this sits next to a status dot in a dense list, not a
 * detail view. Falls back to "just now" under a minute. */
export function formatRelativeTime(from: number, now: number = Date.now()): string {
  const deltaMs = Math.max(0, now - from);
  for (const [label, unitMs] of UNITS) {
    const value = Math.floor(deltaMs / unitMs);
    if (value >= 1) return `${value}${label}`;
  }
  return "just now";
}
