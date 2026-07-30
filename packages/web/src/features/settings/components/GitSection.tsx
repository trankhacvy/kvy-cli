"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getDefaultBranchMode, setDefaultBranchMode } from "@/features/new-session/git-defaults";

/**
 * Settings → Git (docs/features/worktree-isolation.md Phase 5,
 * docs/competitive-notes-omnara.md #2): the New Session wizard's per-device
 * default branch mode. Moved verbatim out of the deleted
 * `app/(protected)/settings/git/page.tsx` route — page chrome dropped,
 * behavior unchanged (a pair of `aria-pressed` buttons reading/writing
 * `git-defaults.ts`'s `localStorage` preference directly, plus the
 * informational GitHub card).
 */
export function GitSection() {
  const [mode, setMode] = useState(() => getDefaultBranchMode());

  function choose(next: "repo-root" | "new-branch") {
    setDefaultBranchMode(next);
    setMode(next);
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Choose what a new session starts on by default.
      </p>

      <div className="flex flex-col gap-2">
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
        This only sets the New Session wizard's starting choice. It's always changeable per session,
        and is per-device, not synced across your other devices.
      </p>

      {/*
       * GitHub PR/CI integration (docs/features/github-pr-ci.md, docs/
       * competitive-notes-omnara.md #4): deliberately an informational card,
       * not a live connect/disconnect toggle. The GitHub token is a
       * machine-local secret (`~/.falcon/github.key`, `falcon github
       * login`) — it lives on whichever machine's daemon runs the session,
       * never on this account or this browser. A single account-level
       * "Connect GitHub" toggle would need the *server* to hold that token
       * (or at least broker the connect flow) so it could show one
       * consistent state here — a direct violation of the "server holds no
       * keys, decrypts nothing" invariant (design §5.3). The per-machine
       * model also means there's no single "connected: yes/no" this page
       * could show correctly without a machine selector it doesn't have —
       * so this stays an instructions-only card rather than guessing.
       */}
      <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold">GitHub</h3>
        <p className="text-sm text-muted-foreground">
          GitHub is not connected through this app. CI checks connect per machine: run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            falcon github login
          </code>{" "}
          in a terminal on the machine that hosts your sessions, then open a session&apos;s Checks
          tab.
        </p>
      </div>
    </div>
  );
}
