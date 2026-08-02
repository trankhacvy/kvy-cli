import { Loader2 } from "lucide-react";
import { InlineCommandText } from "@/components/inline-command-text";
import type { InlineSpawnState } from "../use-inline-spawn";

/**
 * Renders the inline creation panel's spawn-lifecycle feedback (B4). Split
 * out as a plain, hook-free component — takes `elapsedSeconds` as a prop
 * rather than computing it itself — so it's directly render-testable via
 * `react-dom/server`'s `renderToStaticMarkup` for every phase (idle,
 * spawning, error, success) without needing this package's absent jsdom/
 * `@testing-library/react` setup (mirrors `SessionTimelineScreen.tsx`'s
 * `LifecycleBanner` extraction for the exact same reason).
 *
 * Past 5s, an honest "this can take a little longer" reassurance is added —
 * still not a fabricated stage, just an acknowledgement that the wait is
 * real and expected up to `spawnAwaiter.ts`'s own ~15-30s ceiling (worktree
 * setup + launch + the 15s webhook wait), so the panel doesn't look frozen.
 */
const SLOW_HINT_THRESHOLD_SECONDS = 5;

export function InlineSpawnStatus({
  state,
  elapsedSeconds,
}: {
  state: InlineSpawnState;
  elapsedSeconds: number | null;
}) {
  if (state.phase === "idle") return null;

  if (state.phase === "spawning") {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
        aria-live="polite"
      >
        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
        <span>
          Starting session… {elapsedSeconds ?? 0}s
          {(elapsedSeconds ?? 0) >= SLOW_HINT_THRESHOLD_SECONDS &&
            ". Setting up a new worktree can take a little longer than usual."}
        </span>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <p className="text-sm text-destructive" role="alert">
        <InlineCommandText text={state.message} />
      </p>
    );
  }

  // state.phase === "success"
  return (
    <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">Session started.</p>
  );
}
