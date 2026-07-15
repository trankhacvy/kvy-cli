# P0-land-0.4-worktrees-onto-main

**Section:** Phase 0 — 0.4 Server foundation (§3.2, §4)
**Type:** Integration re-verification + rebase-forward (no new product code)

## Context: why this ran again

A prior pass on this same branch (commit `03ff892`) already merged the
`P0-land-0.4-worktrees` integration branch (Drizzle schema, `docker-compose.dev.yml`,
auth module, `seq.ts`) and wrote a task-summary claiming the landing was complete and
that the four now-redundant worktrees had been deleted. That claim was **not accurate
as a landing onto the real `main`** — `main` never received this branch (no merge
commit for it exists in `main`'s history; `packages/server/src/db/` still does not
exist on `main` as of its tip `4121603`, and `main`'s own `plan.md` still shows every
0.4 bullet except the Fastify skeleton as unchecked, cycle-by-cycle through cycle 13).
Meanwhile `main` kept moving — most notably `P1-land-cli-scaffold-onto-main` landed
`packages/cli` — so this branch (last touching `main` at `cc17a14`) had fallen behind.

This pass re-verifies mergeability against the *current* `main` tip and brings the
branch up to date so an actual land can happen cleanly next.

## What this did

1. Confirmed `main` genuinely has none of the 0.4 server code (`git show
   main:packages/server/src/db/schema.ts` → does not exist) — the prior summary's
   claim of a completed landing was aspirational, not real.
2. Merged current `main` (tip `4121603`, which includes `P1-land-cli-scaffold-onto-main`
   and cycle 13's tracking commit) into this branch: `git merge --no-ff main`.
3. One conflict, in `plan.md`'s "0.4 Server foundation" status paragraph — both sides
   had rewritten it independently (this branch's prior pass described a completed
   merge that hadn't actually happened on `main`; `main`'s own tracking cycles
   correctly described it as still unmerged). Resolved by writing a fresh paragraph
   that accurately states: this branch now contains the code, `main` doesn't yet, and
   landing this branch is the remaining step. `CLAUDE.md` and `pnpm-lock.yaml`
   auto-merged cleanly (no conflicts — `main`'s CLI-package additions and this
   branch's server/db/auth additions touch disjoint areas).
4. Ran `pnpm install`, then fresh `pnpm build` / `pnpm typecheck` / `pnpm test` on the
   merged tree — all green:
   - `@falcon/server`: 50/55 tests passing, 5 `seq.test.ts` concurrency tests skipped
     (require a live Postgres, unavailable in this sandbox).
   - `@falcon/crypto`: 65/65 tests passing.
   - `@falcon/wire`: 61/61 tests passing.
   - `falcon` (cli): 58/58 tests passing.
   - `pnpm lint` (biome): could not run in this sandbox — `biome check` aborts with
     "Linter process terminated abnormally (possibly out of memory)" even on a single
     file, unrelated to this change (an environment/resource constraint, not a code
     issue). Not a required gate per task instructions (`pnpm build` is).
5. Committed the merge.

## plan.md changes

Checked off the 0.4 bullets that this branch now actually contains, ready to land:
- [x] Drizzle schema (`accounts`/`machines`/`workspaces`/`sessions`/`sessionMessages`/
      `unmanagedSessions`/`pairRequests`/`pushSubscriptions`/`blobs` + `bytea` type)
- [x] `drizzle-kit generate` initial migration; migration-on-boot runner
- [x] `seq.ts`: `allocMsgSeq` / `allocHeaderSeq`
- [x] Auth module: token mint/verify, token cache
- [x] `docker-compose.dev.yml`: postgres:16 for local dev

Rewrote the section's status note to stop describing a merge onto `main` that hadn't
actually happened, and instead accurately describe this branch's current state
(merged forward onto `main`'s current tip, verified green, ready to land) so the next
cycle doesn't repeat the same false-positive.

Left unchecked (correctly, not part of this branch):
- [ ] `POST /v1/auth` Ed25519 challenge/response route
- [ ] OAuth sign-in routes
- [ ] Pairing endpoints

## Explicitly NOT included

`P0-0.4-auth-challenge-route` still carries only the same merged prerequisite commits
plus its own two route-implementation commits; landing those onto `main` after this
branch lands remains a separate follow-up task.

## Per task instructions: no merge into `main`, no push

Per this task's operating rules ("Do NOT merge or push — just commit in the
worktree"), this pass stops at making the branch itself fast-forward/merge-clean and
verified against the current `main` tip, with the commit sitting in this worktree.
Actually landing it onto `main` is a separate integration step, expected next cycle.

## Assumptions

- No live Postgres was available in this sandbox, so `seq.test.ts`'s 5 concurrency
  tests remain skipped, consistent with every prior task-summary for this branch.
- `pnpm lint` failing to execute at all (process abort, not a lint finding) in this
  sandbox is treated as an environment limitation, not a regression introduced here —
  `pnpm build`, the instructed verification gate, is green.
