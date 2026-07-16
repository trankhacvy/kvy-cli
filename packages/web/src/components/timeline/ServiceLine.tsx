import { cn } from "@/lib/utils";

type Tone = "muted" | "error" | "warning" | "hairline";

const toneClass: Record<Tone, string> = {
  muted: "text-muted-foreground",
  error: "text-destructive",
  warning: "text-amber-500",
  hairline: "text-muted-foreground/50",
};

/** Centered, low-emphasis marker line — used for `service` text, mode
 * switches, and turn/subagent boundaries. Every render item kind gets
 * *something* on screen (design principle: no silent data loss), but these
 * are intentionally the quietest thing in the transcript. */
export function ServiceLine({ label, tone = "muted" }: { label: string; tone?: Tone }) {
  return (
    <div className="flex items-center justify-center py-1">
      <span className={cn("text-[11px] tracking-wide uppercase", toneClass[tone])}>{label}</span>
    </div>
  );
}
