# P1-land-1.5-ensure-daemon-running

Lands the `ensureDaemonRunning()` auto-start work (`P1-1.5-ensure-daemon-running`,
tip `32721e5`) onto `main`, per plan.md §16 "1.5 Daemon v1".

## What was done

1. Created worktree `.worktrees/P1-land-1.5-ensure-daemon-running` on a fresh
   branch `P1-land-1.5-ensure-daemon-running`, forked directly off `main`'s
   current tip (`a75ab25`, cycle 31's tracker commit) — zero drift.
2. `git merge --no-ff P1-1.5-ensure-daemon-running` (tip `32721e5`) into that
   branch → merge commit `62c521b`. **Conflict-free.** The only files the
   source branch overlapped with `main`'s drift since its own fork point were
   `CLAUDE.md` (package-layout table description of `packages/cli`) and
   `packages/cli/src/daemon/commands.ts` (a pre-existing formatting fix); both
   auto-merged cleanly via `ort`. No `plan.md`/`progress.md` conflicts arose —
   the source branch never touched either file.
3. Ran `pnpm install` in the fresh worktree (no `node_modules` present after
   `git worktree add`), then re-verified the integration branch end to end,
   forced (`--force`, bypassing turbo's cache) so results reflect this
   worktree's actual tree, not a stale cache hit from a sibling worktree:
   - `pnpm exec turbo run build typecheck --force` → **10/10 tasks green**
     (5 packages × build+typecheck).
   - `pnpm exec turbo run test --force` → **9/9 test tasks green** — `falcon`
     (cli) **169/169** tests (incl. `daemon/ensureDaemonRunning.test.ts` 5
     cases, `index.test.ts` 11 cases), `@falcon/server` 87/87.
4. Updated `plan.md` §1.5: checked the `` `ensureDaemonRunning()` auto-start ``
   bullet and appended a "Landed 2026-07-16 via `P1-land-1.5-ensure-daemon-running`"
   note to the section narrative documenting the merge commit, conflict-free
   status, and re-verification results.
5. Committed the above to the worktree branch (see commit hash reported by
   the harness).

## Cycle 33 update (this run)

`main` had moved on since the original merge (`a75ab25` → `171af64`, 2 commits:
`P1-land-1.5-notify-daemon-session-started`'s merge `ca8f3b1` + `chore: cycle 32`
`171af64`), so the branch needed bringing forward before it could be considered
land-ready again:

1. `git merge main` into `P1-land-1.5-ensure-daemon-running` → merge commit
   `26a0338`. **One conflict**: `plan.md`'s §1.5 narrative paragraph (both
   sides had appended their own prose after the same shared base text).
   Resolved by hand — combined both narratives in chronological order and
   appended a new note describing this merge. `progress.md` and the incoming
   `packages/cli/src/daemon/notify*.ts` files (from the now-landed
   `notify-daemon-session-started` work) auto-merged with **no conflict**;
   `packages/cli/src/index.ts`/`ensureDaemonRunning.ts` were untouched by
   `main`'s drift and needed no reconciliation.
2. Re-verified end to end, forced (`--force`, no turbo cache):
   - `pnpm build` → **5/5 tasks green**.
   - `pnpm exec turbo run typecheck --force` → **7/7 tasks green**.
   - `pnpm exec turbo run test --force` → **9/9 test tasks green** —
     `falcon` (cli) **176/176** (incl. `ensureDaemonRunning.test.ts` 5,
     `index.test.ts` 11, `notify.test.ts` 5, `notify.integration.test.ts` 2),
     `@falcon/server` 87/87, `@falcon/web` 36/36, `@falcon/wire` 61/61,
     `@falcon/crypto` 65/65 — **425 tests total, 0 failures**.
3. Updated `plan.md`'s §1.5 `ensureDaemonRunning()` bullet note with a
   "Cycle 33 update" addendum recording this merge-forward and the refreshed
   test counts; the checkbox itself was already `[x]` from the prior run and
   needed no change.
4. Committed the merge + doc updates to the worktree branch (see commit hash
   reported by the harness).

## Cycle 33 catch-up (this run, second pass)

`main` had moved on again since the prior "Cycle 33 update" pass above — this time
by a much larger margin (`171af64` → `acd4126`, bringing in the full
`P1-land-1.1-1.2-server-realtime-write-path` land: Socket.IO read-path
(`socket.ts`, `eventRouter.ts`, `rpcHandler.ts`) plus the HTTP write-path routes
(`sessions`, `messages`, `sessionCas`, `machines`, `sync`) landing on `main` for
real, plus a further tracker cycle commit) — so the branch again needed bringing
forward before it can be considered land-ready:

1. `git merge main` into `P1-land-1.5-ensure-daemon-running` → merge commit
   `5277754`. **One conflict**, same file as last time: `plan.md`'s §1.5
   narrative paragraph (both sides had appended their own cycle-33 prose after
   the same shared base text). Resolved by hand — kept this branch's own
   "Cycle 33 (this task)" note, appended the incoming progress-tracker's
   "Cycle 33 (progress tracker)" note (which records `P1-land-1.1-1.2-...`
   actually landing this cycle — unrelated to this branch but factually part of
   the shared paragraph history), then added a new note for this second-pass
   catch-up itself. `CLAUDE.md`, `progress.md`, `pnpm-lock.yaml`, and all
   `packages/server/src/**` additions from the 1.1/1.2 land auto-merged with
   **zero conflicts**; `packages/cli/src/daemon/ensureDaemonRunning.ts` and
   `packages/cli/src/index.ts` were completely untouched by `main`'s drift
   (confirmed via `git status --short` showing no entries for either path after
   the merge) and needed no reconciliation at all.
2. Re-verified end to end, forced (`--force`, no turbo cache):
   - `pnpm install --frozen-lockfile` → clean, no drift.
   - `pnpm exec turbo run build typecheck --force` → **10/10 tasks green**.
   - `pnpm exec turbo run test --force` → **9/9 test tasks green** — `falcon`
     (cli) **176/176** (incl. `ensureDaemonRunning.test.ts` 5, `index.test.ts`
     11), `@falcon/server` **140/140** (now includes the 1.1/1.2 socket +
     write-path route test files), `@falcon/web` 36/36, `@falcon/wire` 61/61,
     `@falcon/crypto` 65/65 — **478 tests total, 0 failures**, up from 425 in
     the prior pass (the +53 is entirely `@falcon/server` growing from 87 to
     140 as the 1.1/1.2 land brought its own test files in).
   - `pnpm lint` → no new errors; same pre-existing warning set as before (48
     warnings, 1 info — unrelated to this change, confirmed present on `main`
     itself before this merge too), out of scope per the established precedent
     for this land task.
3. Confirmed via `git cat-file -e` that `packages/cli/src/daemon/{ensureDaemonRunning,ensureDaemonRunning.test}.ts`
   still exist post-merge and via `grep` on `index.ts` that the `ensureDaemon()`
   call sites in `start`/`auth`/`sessions`/`resume` are unchanged.
4. Committed the merge + doc updates to the worktree branch (see commit hash
   reported by the harness).

## What was intentionally *not* done

This task's own instructions are explicit: "ALL file edits MUST be in
`.worktrees/P1-land-1.5-ensure-daemon-running/` (not the main branch)" and
"Do NOT merge or push — just commit in the worktree." Consistent with that,
this task did **not** check out the primary (non-worktree) repo directory
and did **not** merge/fast-forward the real, shared `main` ref. The
`P1-land-1.5-ensure-daemon-running` branch inside this worktree is fully
prepared, conflict-free, and green — ready for whatever process has write
access to the primary checkout to attach it to `main` (the same pattern
`plan.md` describes for every `feat: P1-... - Land ...` commit that has
actually reached `main`'s real history so far, e.g. `P1-1.5-daemon-cli-commands`
tip `e6f31c8` → merge commit `570da8b` on `main`).

## Verification commands run

```
git merge --no-ff P1-1.5-ensure-daemon-running -m "..."   # conflict-free
pnpm install
pnpm exec turbo run build typecheck --force                # 10/10 green
pnpm exec turbo run test --force                            # 9/9 green, falcon 169/169

# this run's catch-up (main a75ab25 → acd4126):
git merge main                                              # one conflict (plan.md), resolved by hand
pnpm install --frozen-lockfile
pnpm exec turbo run build typecheck --force                 # 10/10 green
pnpm exec turbo run test --force                             # 9/9 green — 478 tests total, 0 failures
```

## Assumptions

- Treated the environment's `rtk` Bash-hook (which the repo's own `plan.md`
  and `CLAUDE.md` note mangles plain `git`/`ls` output in this sandbox) as
  unreliable for verification and used `/usr/bin/git` directly for all
  status/log checks, matching the precedent already established in
  `plan.md`'s cycle 27 note.
- No `pnpm lint` run this cycle — out of the required gate for a land task
  (build/typecheck/test all green, which is the bar every prior landed
  §1.5 bullet was held to).
