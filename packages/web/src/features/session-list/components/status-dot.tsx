import { cn } from "@/lib/utils";
import { SESSION_STATUS_META, type SessionListStatus } from "../status";

/**
 * The attention dot for one session (design §9.2 "Home" row: "attention
 * dots"). A plain colored dot rather than an icon set — legible at the small
 * size a dense session list needs, and language-independent.
 */
export function SessionStatusDot({ status }: { status: SessionListStatus }) {
  const meta = SESSION_STATUS_META[status];
  return (
    <span className="relative inline-flex size-2.5 shrink-0" title={meta.label}>
      {meta.pulse && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
            meta.dotClassName,
          )}
        />
      )}
      <span className={cn("relative inline-flex size-2.5 rounded-full", meta.dotClassName)} />
    </span>
  );
}
