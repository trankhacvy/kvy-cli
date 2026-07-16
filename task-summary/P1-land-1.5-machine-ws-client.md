# P1-land-1.5-machine-ws-client

Lands the machine-scoped WS client work (`P1-1.5-machine-ws-client`, tip
`8e884c5`) onto `main`, per plan.md §16 "1.5 Daemon v1" — unlanded for 9
consecutive progress-tracker cycles (since Cycle 36).

## Cycle 47 reconciliation (this task)

This branch (tip `efb36f7`) had previously been reconciled against `main`'s
Cycle 44 tip (`185ebc9`) and was confirmed fast-forwardable — but it sat
worktree-local for 10+ further cycles while `main` kept moving (through the
`persistence.ts`/`session/bootstrap.ts` and `sessionExit.ts`→
`packages/server/.../sessionStatus.ts` refactor landings), reaching tip
`3e59f6d`. By the time this task started, `git merge-base --is-ancestor main
HEAD` was **false** again — the earlier fast-forward window had closed.

This task's actual work:

1. `git merge main --no-ff` inside this worktree. Two conflicts, both
   narrative-only:
   - `CLAUDE.md`'s `packages/cli` package-layout bullet — resolved by
     keeping both the machine-scoped WS client description (this branch)
     and the `persistence.ts` description (`main`), and narrowing the
     trailing "[planned]" list to what both branches agree is still missing
     (RPC handler registration, Auth, provider spawning).
   - `plan.md`'s §1.5 machine-ws-client bullet — `main`'s copy still showed
     `[ ]` unchecked with only the Cycle-44/45 "not yet landed" narrative;
     this branch's copy was `[x]` with the fuller "Landed via
     `P1-land-1.5-machine-ws-client`" narrative. Resolved by keeping this
     branch's `[x]` version (superset of `main`'s narrative plus the actual
     landing note) and appending a new paragraph recording this
     reconciliation.
   - Every code/test file auto-merged cleanly — `machineClient.ts` and its
     two test files are disjoint from every file `main`'s drift touched
     (`persistence.ts`, `session/bootstrap.ts`, `api/sessionStatus.ts`,
     `server/app/routes/sessionStatus.ts`, `server/db/testDbAvailable.ts`,
     etc.), so nothing else needed hand resolution.
2. Re-ran `pnpm install`, `pnpm build` (5/5 tasks green), `pnpm exec turbo
   run typecheck --force` (9/9 green), `pnpm exec turbo run test --force`
   (9/9 tasks green: `falcon` cli **270/270** tests incl.
   `daemon/machineClient.test.ts` 18/18 and
   `daemon/machineClient.integration.test.ts` 1/1, `@falcon/server`
   **145/145**).
3. Committed the merge to this worktree's branch. Fast-forwarding the
   primary (non-worktree) `main` checkout onto this reconciled tip remains a
   follow-up step outside this task's write access, same as every prior
   `P1-land-*` task.

## What was done (original merge, prior cycle)

1. Created worktree `.worktrees/P1-land-1.5-machine-ws-client` on a fresh
   branch of the same name, forked directly off `main`'s then-current tip
   `185ebc9` (Cycle 44's tracker commit) — zero drift to reconcile beyond
   the merge itself.
2. `git merge --no-ff P1-1.5-machine-ws-client` (tip `8e884c5`, feat + a
   test-fix commit + a code-review-fixes commit) → merge commit `609e7a0`.
   **Conflict-free.** The source branch's diff against `main` touches only
   new, disjoint files (`packages/cli/src/daemon/machineClient.ts` +
   `machineClient.test.ts` + `machineClient.integration.test.ts` + its own
   `task-summary/P1-1.5-machine-ws-client.md`) plus a small, additive change
   to the already-merged `daemon/state.ts` (a backward-compatible optional
   `machineId?: string` field and a matching runtime-guard clause — every
   pre-existing `DaemonState` literal on `main` still typechecks unchanged)
   and dependency additions in `packages/cli/package.json`/`pnpm-lock.yaml`
   (`@falcon/crypto` workspace dep, `socket.io-client` runtime dep,
   `socket.io` devDependency for the integration test's real WS server — all
   three versions already present in the lockfile via `@falcon/server`'s own
   deps, so `pnpm install` resolved without adding new package versions to
   the tree). `plan.md`/`progress.md` were untouched by the source branch,
   so no narrative conflicts there either.
3. Verified the already-merged dependencies this branch needs actually exist
   on `main` before merging: `packages/server/src/app/routes/machines.ts`
   (`POST /v1/machines` register/update-with-CAS route) and
   `packages/wire/src/rows.ts`'s `MachineRowSchema`/`EncryptedBoxSchema` —
   both present and matching the shapes `machineClient.ts` imports.
4. Ran `pnpm install` in the fresh worktree, then re-verified end to end,
   forced (`--force`, bypassing turbo's cache) so results reflect this
   worktree's actual tree:
   - `pnpm build` → **5/5 tasks green** (`tsc --noEmit` + `pkgroll`/`next
     build` per package — this is the project's typecheck gate, there is no
     separate `typecheck` script at the root).
   - `pnpm exec turbo run test --force` → **9/9 test tasks green** —
     `falcon` (cli) **225/225** tests (incl. the new
     `daemon/machineClient.test.ts` 18 cases and
     `daemon/machineClient.integration.test.ts` 1 real-socket.io case),
     `@falcon/server` **140/140** (incl. its own `routes/machines.test.ts`
     6/6, unaffected by this change), `@falcon/web` 56/56, `@falcon/wire`
     61/61.
5. Updated `plan.md` §16 "1.5 Daemon v1": checked the "Machine-scoped WS
   client: register, heartbeat 60s, encrypted metadata/daemonState CAS sync"
   bullet and appended a "Landed 2026-07-16 via
   `P1-land-1.5-machine-ws-client`" note to the section narrative recording
   the merge commit, conflict-free status, and re-verification counts.
6. Updated `CLAUDE.md`'s package-layout table entry for `packages/cli` to
   list the machine-scoped WS client alongside the other daemon pieces
   instead of "[planned]", and narrowed the remaining "[planned]" note to
   what's actually still missing (RPC handler registration, Auth,
   provider spawning).
7. Committed all of the above (merge + `plan.md`/`CLAUDE.md` doc updates) to
   this worktree's branch.

## Scope note (sandboxing)

Per this task's rules ("ALL file edits MUST be in the worktree… do NOT merge
or push"), the merge above lives on the `P1-land-1.5-machine-ws-client`
branch inside this worktree only. Fast-forwarding or `--no-ff`-merging this
branch onto the shared `main` ref itself (from the primary, non-worktree
checkout) is a follow-up step outside this task's own write access — the
same pattern every prior `P1-land-*` task in §1.5 has followed (see
`P1-land-1.5-ensure-daemon-running`'s task-summary for the two-step
precedent: worktree-local merge first, then a separate fast-forward from the
primary checkout).

## Verification note

This environment's `rtk` Bash-hook intermittently rewrites plain `git`
output (matching the pre-existing issue plan.md's narrative already
documents for earlier cycles — e.g. `git log --oneline` showing a stale
tip that didn't include the just-created merge commit). All commit-hash and
tree-state claims above were cross-checked with `/usr/bin/git` directly
(bypassing the hook) before being recorded here.
