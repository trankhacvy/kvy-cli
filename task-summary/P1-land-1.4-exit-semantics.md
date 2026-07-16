# P1-land-1.4-exit-semantics — Land exit-semantics classification onto main

## Task

Merge the already-implemented, self-verified worktree branch `P1-1.4-exit-semantics`
(tip `835843d`) onto the primary `main` checkout. No `P1-land-*` branch existed yet for
this piece of work, so this task both created the land branch and performed the merge.

## What this task did

1. Confirmed `main`'s actual tip (`78f22af`) vs. the drift the task description was
   written against (`0bf99d4`): the only intervening commit was a no-op progress-tracker
   cycle marker ("chore: cycle 46 — completed 0 tasks (P1-1.4-exit-semantics confirmed
   unlanded)") — zero real file drift on anything `P1-1.4-exit-semantics` touches.
2. Created worktree `.worktrees/P1-land-1.4-exit-semantics` on a new branch
   `P1-land-1.4-exit-semantics`, branched from `main` at `78f22af`.
3. `git merge --no-ff P1-1.4-exit-semantics` — clean, conflict-free (disjoint file set,
   as the task description promised: no overlap with `CLAUDE.md`/`package.json`/other
   concurrent land tasks). Brought in:
   - `packages/server/src/app/routes/sessionStatus.ts` (+ test) — idempotent
     `POST /v1/sessions/:id/status`, one-way transition to `failed`, fans out
     `session-update` + `attention{kind:"failed"}` via the existing `EventRouterPort`.
   - `packages/server/src/app/server.ts` — route registration (2-line addition).
   - `packages/cli/src/api/sessionStatus.ts` (+ test) — `reportSessionFailed`,
     best-effort POST client, never throws, timeout-bounded.
   - `packages/cli/src/claude/sessionExit.ts` (+ test) — `createSessionExitTracker`,
     classifying a settled `claudeLocal(...)` outcome into `clean-exit` / `signal-exit`
     (Ctrl-C/SIGTERM/SIGHUP — no report, session stays resumable) / `crash` (anything
     else — best-effort reported via `reportSessionFailed`).
   - `task-summary/P1-1.4-exit-semantics.md` — the original feature branch's own
     implementation notes (kept as-is; this file is the separate landing report).
4. Ran `pnpm install` (worktree had no `node_modules`), then `pnpm build --force`,
   `pnpm typecheck`, and `pnpm test` workspace-wide, all with cache bypassed at least
   once to confirm a genuine from-scratch pass, not a stale cache replay.
5. Updated `plan.md`'s "Exit semantics" bullet (Phase 1 §1.4) from `[ ]` to `[x]` with a
   landing note, following the same convention used by every other `P1-land-*` entry in
   this file.

## Verification

- `pnpm build --force`: 5/5 tasks green, no cache.
- `pnpm typecheck`: 8/8 tasks green.
- `pnpm test`: 9/9 tasks green —
  - `@falcon/wire`: 61/61
  - `falcon` (cli): 220/220 (includes the 13 new tests this branch adds: 4 in
    `api/sessionStatus.test.ts`, 9 in `claude/sessionExit.test.ts`)
  - `@falcon/server`: 145/145 (includes the 5 new `app/routes/sessionStatus.test.ts` cases)
  - `@falcon/web`, `@falcon/crypto`: unaffected, still green.

No conflicts, no code changes needed beyond the merge itself — the feature branch's
own implementation was already complete and workspace-green.

## Scope note

Per this task's sandboxing rules, all of the above happened inside
`.worktrees/P1-land-1.4-exit-semantics` on branch `P1-land-1.4-exit-semantics`. This
branch is a clean fast-forward candidate onto the shared `main` ref (its merge-base with
`main` is exactly `main`'s tip at the time this task ran). Actually moving the shared
`main` ref itself (fast-forward or `--no-ff` merge from the primary, non-worktree
checkout) is a follow-up step outside this task's own write access, same as every prior
`P1-land-*` task in this repo's history.
