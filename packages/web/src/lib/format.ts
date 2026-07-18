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

/** Local wall-clock hour bucket start (epoch ms) for `shouldShowHourDivider`
 * below — two envelope times are "the same hour" iff they share one of
 * these, so hour boundaries follow the *viewer's* clock (not a fixed UTC
 * grid): a run spanning 2:58-3:02 still gets a divider right at 3:00. */
function hourBucketStart(ms: number): number {
  const date = new Date(ms);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

/** Whether an hourly divider (`TimelineRow`, plan-v2.md W4.2) should render
 * immediately before an item at `time`, given the previous rendered item's
 * `time` (`undefined` for the very first item in the list — always shown,
 * so the timeline opens with an explicit time anchor rather than none). */
export function shouldShowHourDivider(previousTime: number | undefined, time: number): boolean {
  if (previousTime === undefined) return true;
  return hourBucketStart(previousTime) !== hourBucketStart(time);
}

/** Hourly-divider label, e.g. "Jul 18, 3:00 PM". Locale pinned to `en-US`
 * (like every other formatter in this file) so rendering is deterministic
 * regardless of the host machine's locale, not because Falcon only
 * supports English. */
export function formatHourDividerLabel(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(hourBucketStart(ms)));
}

/** Full-precision timestamp for a timeline row's hover tooltip (plan-v2.md
 * W4.2 "Timestamps"), e.g. "Jul 18, 2026, 3:45:12 PM". */
export function formatFullTimestamp(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(ms));
}
