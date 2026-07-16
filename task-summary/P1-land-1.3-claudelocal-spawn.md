# P1-land-1.3-claudelocal-spawn — Land `claudeLocal.ts` port onto main

## Task

Land the complete, self-verified `claudeLocal.ts` port (branch/worktree
`P1-1.3-claudelocal-spawn`) onto the shared `main` ref: reconcile this integration
branch with `main`'s current tip, keep the full suite green, flip the `plan.md`
checkbox, and write this summary. Per this task's own instructions, all work here
happens *inside the worktree* — no merge/push to the shared `main` ref is performed
by this pass; that final step is executed separately, from a non-worktree checkout.

## Starting state (this pass)

- This worktree's branch (`P1-land-1.3-claudelocal-spawn`, tip `0ddc131`) already
  contained the ported `packages/cli/src/claude/claudeLocal.ts` +
  `claudeLocal.test.ts` (merged in from source branch `P1-1.3-claudelocal-spawn`,
  tip `ef09289`, in an earlier pass), plus a `plan.md` checkbox flip that
  **prematurely claimed** the work was "landed ... directly onto `main`".
- Independently confirmed that claim was **not yet true**: `main`'s real tip
  (`237202d`) has no `claudeLocal.ts` (`git cat-file -e
  main:packages/cli/src/claude/claudeLocal.ts` fails) and
  `git merge-base --is-ancestor HEAD main` / `main`'s own `git log` shows this
  branch was never actually merged into the shared ref — only into this worktree's
  own local branch. `main`'s own `plan.md` still has the bullet as `[ ]`. This
  discrepancy was already independently flagged in `progress.md` cycles 38/40
  ("land task lands onto its own worktree branch, not onto the real `main`").
- Meanwhile `main` had advanced 5 commits past this branch's fork point
  (`a7bbceb`), most notably landing `P1-1.6-reducer-port`'s sync-engine reducer
  (`packages/web/src/sync/reducer/**`, +`@falcon/wire` as a new `packages/web`
  dependency).

## What was done

1. `git fetch . main:refs/heads/main-ref-tmp` — confirmed `main`'s real current tip
   is `237202d` (5 commits ahead of this branch's `a7bbceb` fork point).
2. `git merge main --no-ff` — clean, conflict-free ("Merge made by the 'ort'
   strategy"; auto-merged `plan.md` and `pnpm-lock.yaml`, no manual conflict
   resolution needed). Brought in `P1-1.6-reducer-port`'s files
   (`packages/web/src/sync/reducer/**`, `progress.md`, two `task-summary/*`
   files) with zero overlap against `claudeLocal.ts`/`claudeLocal.test.ts`.
3. Corrected the `plan.md` §1.3 `claudeLocal.ts port` bullet's note: removed the
   premature "landed directly onto `main`" claim (which had gone stale — it
   referenced a `main` tip, `a7bbceb`, that no longer exists as `main`'s tip) and
   replaced it with an accurate description of this pass's actual state: work
   merged into this task's own worktree branch, reconciled with `main`'s real
   current tip `237202d`, self-verified, with the actual fast-forward/merge onto
   the primary `main` checkout flagged as the remaining step performed outside
   this worktree. Checkbox itself stays `[x]` (the port itself is complete and
   correct — only the "is it actually on `main` yet" claim needed fixing).
4. Ran `pnpm build` — 5/5 cached green, then forced a real rebuild
   (`pnpm exec turbo run build --force`) to confirm from-scratch correctness.
   **Found and fixed a real (pre-existing, unrelated-to-this-port) issue**:
   `packages/web/node_modules/@falcon/wire` had no symlink (only `@falcon/crypto`
   was linked) — `P1-1.6-reducer-port`'s merge added `@falcon/wire` as a new
   `packages/web` dependency in `package.json`, but the workspace's
   `node_modules` symlinks hadn't been refreshed via `pnpm install` since. This
   caused `@falcon/web#build` to fail with `Cannot find module '@falcon/wire'`.
   Ran `pnpm install` (no `pnpm-lock.yaml` diff — the lockfile was already
   correct, only the on-disk symlink was stale) and confirmed the symlink now
   exists; rebuild is green.
5. Re-verified with forced (no-cache) runs on the reconciled branch:
   - `pnpm exec turbo run build --force` — 5/5 tasks green.
   - `pnpm exec turbo run typecheck --force` — 8/8 tasks green.
   - `pnpm exec turbo run test --force` — 9/9 tasks green; `falcon` (cli)
     206/206 tests, `@falcon/server` 140/140 tests.
   - `pnpm lint` — hit `[warn] Linter process terminated abnormally (possibly
     out of memory)` repeatedly (CLAUDE.md documents this as a known transient
     issue from concurrent-worktree resource contention in this environment;
     even a 3-file scoped `biome check` on just `claudeLocal.ts`/
     `claudeLocal.test.ts`/`plan.md` hit the same OOM warning). Not treated as a
     code issue — the ported files themselves are unchanged from the source
     branch's own previously-reported clean lint state, and none of this pass's
     edits touch lint-sensitive code (only `plan.md` prose + a reconciliation
     merge).

## Sanity-check retained from prior pass: bare `--resume`/`-r` passthrough

Re-confirmed (unchanged by the reconciliation merge — no conflicting edits to
`claudeLocal.ts`): `resolveSessionFlags`/`extractFlag`'s `withValue: true` variant
returns `{ found: false }` for a bare trailing `--resume`/`-r` (no value, or
immediately followed by another flag), so `resolveSessionFlags` never triggers
Falcon's own last-session lookup for that case, and `claudeLocal()`'s
`hasResumeFlagLeft` check leaves the bare flag in `claudeArgs` untouched — it rides
through to the real `claude` invocation, which shows its own interactive resume
picker. Matches falcon-plan.md's stated goal ("`falcon --resume` behaves exactly
like `claude --resume`"). No change made.

## Verification

- `git merge main --no-ff` onto this branch — conflict-free, reconciled with
  `main`'s real tip `237202d`.
- `pnpm exec turbo run build --force` — 5/5 green (after fixing the stale
  `@falcon/wire` symlink via `pnpm install`).
- `pnpm exec turbo run typecheck --force` — 8/8 green.
- `pnpm exec turbo run test --force` — 9/9 green (`falcon` cli 206/206,
  `@falcon/server` 140/140).
- `plan.md` §1.3 `claudeLocal.ts` port checkbox remains `[x]`, note corrected to
  accurately reflect current (not-yet-on-shared-`main`) state.

## Remaining step (out of this worktree's scope, per task instructions)

This pass does not merge or push to the shared `main` ref — only commits inside
this worktree. The branch (`P1-land-1.3-claudelocal-spawn`) is now fully
reconciled with `main`'s real current tip, conflict-free, and green end-to-end.
The actual fast-forward/merge of this branch onto the primary `main` checkout
(from a non-worktree working directory) is the one remaining action needed to make
the `plan.md` note's "landed" claim true.

## Out of scope (unchanged from prior passes)

Full local-mode integration (actually spawning the launcher + `cliLocator`-resolved
Claude CLI end-to-end) still needs `P1-1.3-claude-launcher-script` and
`P1-1.3-cli-locator` landed — both remain unmerged siblings as of this pass. Wiring
`claudeLocal()` into `index.ts`/`loop.ts` is a separate, later plan bullet.
