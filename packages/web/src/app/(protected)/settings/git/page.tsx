"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getDefaultBranchMode, setDefaultBranchMode } from "@/features/new-session/git-defaults";

/**
 * Settings → Git (docs/features/worktree-isolation.md Phase 5,
 * docs/competitive-notes-omnara.md #2): the New Session wizard's per-device
 * default branch mode. Mirrors `AppearanceSettingsPage`'s shape exactly —
 * thin "use client" component, no server round-trip, a pair of
 * `aria-pressed` buttons reading/writing `git-defaults.ts`'s `localStorage`
 * preference directly.
 */
export default function GitSettingsPage() {
  const [mode, setMode] = useState(() => getDefaultBranchMode());

  function choose(next: "repo-root" | "new-branch") {
    setDefaultBranchMode(next);
    setMode(next);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center gap-8 p-8 text-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Git</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose what a new session starts on by default.
        </p>
      </div>

      <div className="flex w-full flex-col gap-2">
        <Button
          type="button"
          variant={mode === "new-branch" ? "default" : "outline"}
          aria-pressed={mode === "new-branch"}
          className="h-auto flex-col items-start gap-0.5 whitespace-normal p-3 text-left"
          onClick={() => choose("new-branch")}
        >
          <span className="font-medium">New worktree (Recommended)</span>
          <span className="font-normal opacity-80">
            Each new session starts on its own branch in an isolated worktree.
          </span>
        </Button>
        <Button
          type="button"
          variant={mode === "repo-root" ? "default" : "outline"}
          aria-pressed={mode === "repo-root"}
          className="h-auto flex-col items-start gap-0.5 whitespace-normal p-3 text-left"
          onClick={() => choose("repo-root")}
        >
          <span className="font-medium">Repo root</span>
          <span className="font-normal opacity-80">
            Sessions work directly in the main checkout.
          </span>
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        This only sets the New Session wizard's starting choice — it's always changeable per
        session, and is per-device, not synced across your other devices.
      </p>
    </main>
  );
}
