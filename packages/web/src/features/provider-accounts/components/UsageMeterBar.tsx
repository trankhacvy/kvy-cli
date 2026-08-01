import type { ProviderUsageMeter } from "@kvy/wire";
import { cn } from "@/lib/utils";
import { formatUsageMeterLabel } from "../format";

/**
 * One usage-limit window's meter (docs/competitive-notes-omnara.md #9: "a
 * monthly usage meter with a reset date" — `label`/the window itself come
 * straight from whatever period the local CLI's own cache reports, e.g.
 * Claude Code's "Session"/"Weekly" buckets, not a fixed monthly cadence this
 * UI invents). No `<progress>`/shadcn `Progress` component exists in this
 * package yet — a plain filled bar matches every other "no new dependency
 * for one bar" precedent in this codebase.
 */
export function UsageMeterBar({ meter }: { meter: ProviderUsageMeter }) {
  const percent = Math.max(0, Math.min(100, meter.percentUsed));
  const severity =
    meter.percentUsed >= 100
      ? "bg-destructive"
      : meter.percentUsed >= 80
        ? "bg-amber-500"
        : "bg-primary";

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">{meter.label}</p>
      <div
        role="progressbar"
        aria-label={`${meter.label} usage`}
        aria-valuenow={Math.round(meter.percentUsed)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full transition-[width]", severity)}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{formatUsageMeterLabel(meter)}</p>
    </div>
  );
}
