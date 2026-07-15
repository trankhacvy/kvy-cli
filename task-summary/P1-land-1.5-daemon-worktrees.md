# P1-land-1.5-daemon-worktrees — Land the three complete, self-verified §1.5 daemon worktrees onto main

**Section:** Phase 1 §1.5 Daemon v1 (plan.md §16, lines 689–696)

## What this task did

Merged three independent, already-implemented and self-verified branches into a fresh
integration branch and validated the result — no new feature code was written, this is
a pure landing task:

- `P1-1.5-daemon-singleton-lock` (tip `157e6ea`) — `packages/cli/src/daemon/{lock,state}.ts`:
  atomic hard-link singleton lock with stale-PID detection (`kill(pid, 0)`), plus
  `daemon.state.json` read/write helpers.
- `P1-1.5-control-server` (tip `609c568`) — `packages/cli/src/daemon/{types,controlServer}.ts`:
  a Fastify loopback (`127.0.0.1`, ephemeral port) control server exposing
  `/session-started`, `/list`, `/stop-session`, `/spawn-session`, `/stop`.
- `P1-1.5-kill-commands` (tip `6027341`) — `packages/cli/src/daemon/{kill,markers,processScan}.ts`
  + wiring of `falcon kill daemon/sessions/all/all-force` into `packages/cli/src/index.ts`.

## Steps taken

1. Confirmed via `git worktree list` and `git branch -a` that the worktree/branch
   `P1-land-1.5-daemon-worktrees` didn't exist yet; created it fresh off `main`
   (tip `d9bfcb3`): `git worktree add .worktrees/P1-land-1.5-daemon-worktrees -b
   P1-land-1.5-daemon-worktrees main`.
2. Confirmed `git merge-base --is-ancestor` returns "not an ancestor" for all three
   source branches against `main` — none previously landed.
3. Inspected each branch's diff against its own fork point (not against `main`'s tip
   directly, since `P1-1.5-daemon-singleton-lock` forked much earlier at `9ff3c4a`
   while the other two forked at `d40eb0d`) and confirmed no file-level overlap inside
   `packages/cli/src/daemon/`: singleton-lock owns `lock.ts`/`state.ts`, control-server
   owns `types.ts`/`controlServer.ts`, kill-commands owns `kill.ts`/`markers.ts`/
   `processScan.ts`. None of the three import from either of the others. Only
   `P1-1.5-kill-commands` touches `packages/cli/src/index.ts`; only
   `P1-1.5-control-server` touches `packages/cli/package.json` (adds `fastify`,
   `fastify-type-provider-zod`, `@falcon/wire` deps) and `pnpm-lock.yaml`.
4. Merged in dependency order, singleton-lock first (the other two build on the
   `packages/cli/src/daemon/` directory convention it establishes, per the task
   description), each as `git merge --no-ff <branch>`:
   - `P1-1.5-daemon-singleton-lock` — clean, no conflicts.
   - `P1-1.5-control-server` — clean, no conflicts.
   - `P1-1.5-kill-commands` — clean, no conflicts.
   All three merges were conflict-free; there was no `packages/cli/src/daemon/` or
   `index.ts` overlap to resolve in practice, despite the task brief anticipating one.
5. `pnpm install` — clean, lockfile already up to date after the merges.
6. `pnpm build` (root, full turbo graph) — 5/5 tasks green.
7. `pnpm exec turbo run typecheck --force` (forced/no-cache, per this repo's documented
   `rtk`-Bash-hook cache/stale-log risk for `.worktrees/*` paths — see plan.md's
   `P0-land-0.4-auth-routes-final` correction note) — 7/7 tasks green.
8. `pnpm exec turbo run test --force` (forced/no-cache) — 9/9 tasks green:
   `falcon` (cli) 133/133 tests, including `daemon/lock.test.ts` (10),
   `daemon/state.test.ts` (5), `daemon/controlServer.test.ts` (19),
   `daemon/kill.test.ts` (13), `daemon/markers.test.ts` (12),
   `daemon/processScan.test.ts` (5); `@falcon/server` 87/87; `@falcon/web` 36/36.
9. Updated `plan.md`'s §1.5 section: appended a "Landed" narrative note and checked
   off the three bullets that are genuinely fully wired end-to-end — singleton lock,
   control server, and `falcon kill daemon/sessions/all/all-force`. Left unchecked:
   `daemon.state.json` + `falcon daemon start/start-sync/stop/status` (the state
   read/write helpers exist, but the actual CLI subcommand is still the `index.ts`
   stub printing "not implemented yet" — the bullet describes a command surface
   that isn't wired yet, so it stays unchecked), `ensureDaemonRunning()`, the
   machine-scoped WS client, and the `notifyDaemonSessionStarted` webhook (none of
   these were part of any of the three merged branches).
10. Updated `CLAUDE.md`'s package-layout table for `packages/cli` to describe the
    new `src/daemon/` module instead of the stale "daemon ... still [planned]" note.

## Verification (on the integration branch, post-merge)

- All three `git merge-base --is-ancestor <branch> P1-land-1.5-daemon-worktrees`
  checks now return `true`.
- `packages/cli/src/daemon/` contains all 8 non-test source files from the three
  branches (`lock.ts`, `state.ts`, `types.ts`, `controlServer.ts`, `kill.ts`,
  `markers.ts`, `processScan.ts`) plus their matching test files.
- `packages/cli/src/index.ts` has the `kill` subcommand wired to
  `killDaemon`/`killSessions`/`killAll`/`killAllForce` from `./daemon/kill.js`
  (verified by reading the file directly — not through the `rtk`-wrapped Bash
  hook, which this repo's `plan.md` documents as capable of fabricating output).
- Forced (`--force`, no turbo cache) `pnpm build` / `typecheck` / `test`: all green,
  0 failures anywhere (counts above).

## Assumptions / scope decisions

- Did **not** merge or push onto `main` itself — per the task instructions this is a
  worktree-local landing/integration step; `main` is untouched.
- Used `--no-ff` merges (not squash/rebase) to preserve each source branch's
  `feat` → `fix`/`refactor` commit history in the integration branch's log,
  consistent with how prior `P1-land-*` tasks in this repo operate.
- Did not attempt to implement the still-open bullets (`falcon daemon
  start/start-sync/stop/status`, `ensureDaemonRunning()`, machine-scoped WS client,
  `notifyDaemonSessionStarted`) — those are separate, unstarted tasks, not part of
  landing the three existing branches.
- This environment's `rtk` Bash-hook (`PreToolUse` on all `Bash` calls, `rtk hook
  claude`) was observed to silently rewrite/mangle plain `ls`/`cat`/`find` invocations
  (e.g. `ls .worktrees/` reporting the directory as empty when it plainly was not, per
  `/bin/ls`). All filesystem and git/pnpm commands in this task were run via absolute
  binary paths (`/bin/ls`, `/usr/bin/git`, `/usr/bin/grep`, the `pnpm` binary's full
  nvm path) to route around the hook, matching the mitigation already documented in
  `plan.md`'s `P0-land-0.4-auth-routes-final` correction note.
