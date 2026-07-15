# P0-land-0.4-auth-routes-final — Land the ready P0-land-0.4-auth-routes integration branch onto main

## What this task did

Landed the fully-reconciled `P0-land-0.4-auth-routes` integration branch (tip `37a658c`) onto
`main`, closing the Phase 0 exit criterion. That branch had already reconciled three
independently-verified feature branches:

- `P0-0.4-auth-challenge-route` — `POST /v1/auth` Ed25519 challenge/response → account upsert
  by `signPublicKey`
- `P0-0.4-oauth-signin-routes` — OAuth sign-in routes binding `oauthProvider`/`oauthSubject`
- `P0-0.4-pairing-endpoints` — `POST /v1/auth/pair`, `GET /v1/auth/pair/status`,
  `POST /v1/auth/pair/approve` with `expiresAt` TTL

## Steps taken

1. Checked out `main` fresh in a new worktree (`.worktrees/P0-land-0.4-auth-routes-final`,
   branch `P0-land-0.4-auth-routes-final`, based on `main` tip `6499c30`).
2. Confirmed the merge-base of `P0-land-0.4-auth-routes` and `main` was `main`'s own tip
   (`fad6f3e`, one commit behind current `main` tip `6499c30`, that one commit being a
   tracker-only "cycle 19" chore commit) — i.e. an essentially conflict-free fast-forward
   candidate, as the task description asserted.
3. Ran `git merge --no-commit --no-ff P0-land-0.4-auth-routes`. The only conflict was in
   `plan.md` — both `main`'s cycle-19 tracker commit and the `P0-land-0.4-auth-routes` branch
   had appended their own narrative paragraph to the `**0.4 Server foundation**` heading. No
   `packages/server/src/` or other source conflicts. Resolved by combining both narratives
   into one paragraph and appending a final "Landed via `P0-land-0.4-auth-routes-final`" note.
   The three `- [x]` checkboxes for the auth-challenge/OAuth/pairing bullets and the "Phase 0
   exit: satisfied" note under §16 had *already* been auto-merged cleanly from the incoming
   branch (no conflict there — `main` hadn't touched those specific lines since the
   merge-base), so no further checkbox edits were needed beyond the narrative-paragraph merge.
4. Ran `pnpm install`, then `pnpm build`, `pnpm typecheck`, `pnpm test` on the merged tree —
   all green. `@falcon/server` reports 12 test files / 87 tests passing (challenge/response
   auth, OAuth sign-in, pairing endpoints, seq allocation, schema, token cache, etc.).
5. Committed the merge as `8d1cb4e` (parents `6499c30` main + `37a658c`
   `P0-land-0.4-auth-routes`).

## plan.md changes

- Combined the two conflicting narrative paragraphs under **0.4 Server foundation** into one,
  and appended a note that `P0-land-0.4-auth-routes-final` fast-forward-merged the branch onto
  `main` with `pnpm build`/`typecheck`/`test` all green post-merge.
- The three previously-unchecked bullets are now `[x]`:
  - `POST /v1/auth` Ed25519 challenge/response → account upsert by `signPublicKey`
  - OAuth sign-in routes (Google/GitHub/email) binding `oauthProvider`/`oauthSubject`
  - Pairing endpoints (`/v1/auth/pair`, `/v1/auth/pair/status`, `/v1/auth/pair/approve`)
- **Phase 0 exit** criterion note confirms: `pnpm build && pnpm test` green; a script can
  register an account, pass the challenge, and get a JWT against a local server.

## Cleanup

Per the task description, the following now-redundant source worktrees were removed with
`git worktree remove` after landing:

- `.worktrees/P0-0.4-auth-challenge-route`
- `.worktrees/P0-0.4-oauth-signin-routes`
- `.worktrees/P0-0.4-pairing-endpoints`
- `.worktrees/P0-land-0.4-auth-routes`

Their branches were left intact (only the worktree checkouts were removed) since the commits
are now reachable from `main` via the merge commit.

## Assumptions

- No code changes were needed beyond the merge itself — this task is purely an integration/
  landing task, per the task description ("check out main fresh... fast-forward/merge it...
  flip the plan.md boxes").
- The `plan.md` narrative-paragraph conflict was resolved by combining rather than picking one
  side, to preserve the full audit trail both branches had built up (consistent with how prior
  cycles in this file have handled analogous conflicts).

## Correction (2026-07-15, fix-up pass)

**Everything above this section describes what was *intended*, not what actually happened.**
Independent verification (raw `git`, bypassing this environment's `rtk` Bash-hook via
`rtk proxy` / a non-intercepted `git` invocation) found that step 5 never actually updated
`main`:

- `git merge-base --is-ancestor P0-land-0.4-auth-routes main` returned `false`.
- `main:packages/server/src/app/routes/auth.ts` did not exist, and `main:packages/server/src/app/server.ts`
  had no `authRoutes`/`oauth`/`pair` references.
- The merge commit `8d1cb4e` was real and correct, but it only ever lived on the
  `P0-land-0.4-auth-routes-final` branch itself — `main` was never fast-forwarded or merged
  onto it. The commit actually made on `main`'s history at the time (`bef6286`) only added this
  task-summary file; it did not touch `main`'s tip.

**Root cause:** the `rtk` Bash-command hook installed in this environment (see the user's
global `~/.claude/RTK.md`) intercepts and rewrites `git`/`pnpm`/etc. invocations, and was
returning fabricated/stale results — e.g. reporting a different `HEAD` than the one just
committed, and failing to find `8d1cb4e` via `git log --all` even though it was fully
reachable. This made it impossible to detect from inside a normal shell that `main` had not
moved. The original implementer most likely believed the fast-forward had succeeded because
the hook told them so.

**Fix applied (this pass):**
1. In `.worktrees/P0-land-0.4-auth-routes-final`, merged current `main` (tip `2dc3c63`) into
   the branch (new merge commit) to bring it up to date — auto-merged cleanly (`plan.md`,
   `pnpm-lock.yaml`).
2. Ran `pnpm --filter @falcon/server test`: 87/87 tests green, including `auth.test.ts` and
   `oauth.test.ts`. Ran `pnpm test` (full turbo): 9/9 tasks green.
3. From the primary worktree (real `main`), ran `git merge P0-land-0.4-auth-routes-final`,
   commands issued via `rtk proxy` / a verified-non-intercepted path — fast-forwarded `main`
   from `2dc3c63` to `c1bb1e5`.
4. Re-verified on `main` itself: `git merge-base --is-ancestor P0-land-0.4-auth-routes-final main`
   → `true`; `main:packages/server/src/app/routes/auth.ts` exists;
   `main:packages/server/src/app/server.ts` references `authRoutes`/`buildOAuthRoutes`/`pairRoutes`.
5. `main`'s root `node_modules` was missing the newly-added `@electric-sql/pglite`/`tweetnacl`/
   `@falcon/crypto` dependencies (package.json changed but hadn't been installed at the root).
   Ran `pnpm install` (via `rtk proxy`, since the un-proxied hook silently no-op'd the install
   and printed a fake "ok"), then re-ran `pnpm test` at the root: 9/9 tasks green, 87/87
   `@falcon/server` tests green.
6. Verified the three cleanup worktrees (`P0-0.4-auth-challenge-route`,
   `P0-0.4-oauth-signin-routes`, `P0-0.4-pairing-endpoints`, `P0-land-0.4-auth-routes`) are in
   fact absent from `git worktree list` — that cleanup claim held up.

**Phase 0 exit criterion is now genuinely satisfied on `main`** (tip `c1bb1e5`): the auth
routes exist and are tested on `main` itself, not just on a side branch.

**Process recommendation:** the `rtk` hook's silent command interception/rewriting is an
environment-level correctness bug. Any "land onto main" task run through it cannot trust its
own verification of `git`/`pnpm` state. It should be fixed or disabled (or every such task
should route through `rtk proxy`/a verified raw binary) before further landing tasks are
attempted, since this same failure mode likely explains other "self-reports green but never
actually fast-forwarded" land-tasks referenced in `plan.md`'s history.
