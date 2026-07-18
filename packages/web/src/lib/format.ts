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

  const digits = value < 10 ? 1 : 0;
  return `${value.toFixed(digits)}${units[unitIndex]}`;
}
