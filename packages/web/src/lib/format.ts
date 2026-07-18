/** Human-readable byte size, base-1024 (`FileItem.size` — falcon-system-design.md §4.2). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  const digits = value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

/** Compact token-count display for the per-turn usage chip (`UsageChip`,
 * plan-v2.md W4.6, AI Elements `Context` pattern) — base-1000 (k/M/B), not
 * base-1024 like `formatBytes`: token counts are a plain decimal quantity,
 * not a byte size. */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  if (count < 1000) return `${count}`;

  const units = ["k", "M", "B"];
  let value = count / 1000;
  let unitIndex = 0;

  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex++;
  }

  // Re-check after rounding: toFixed() can round the displayed value up
  // across a unit boundary (e.g. 999.95 -> "1000") or across the
  // one-decimal/whole-number boundary (e.g. 9.999 -> "10.0") that decided
  // `digits` in the first place. Recompute in either case so the rendered
  // string reflects the rounded value, not the pre-rounding one.
  let digits = value < 10 ? 1 : 0;
  let rounded = Number(value.toFixed(digits));
  if (rounded >= 1000 && unitIndex < units.length - 1) {
    unitIndex++;
    value /= 1000;
    digits = value < 10 ? 1 : 0;
    rounded = Number(value.toFixed(digits));
  } else if (digits === 1 && rounded >= 10) {
    digits = 0;
    rounded = Number(value.toFixed(digits));
  }

  return `${rounded.toFixed(digits)}${units[unitIndex]}`;
}
