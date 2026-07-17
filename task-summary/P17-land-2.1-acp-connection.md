# P17-land-2.1-acp-connection — land `P17-2.1-acp-connection` onto main for real

Section: plan.md §16 "17. v2 — ACP migration / Phase 2.1 — ACP core", first bullet
(line ~1003). Pure landing task — no new implementation; see
`task-summary/P17-2.1-acp-connection.md` for what the code itself does.

## Problem

`main` HEAD (`cc3e9ae`) had no trace of `AcpConnection` at all — confirmed before
starting via `git cat-file -e main:packages/cli/src/acp/acpConnection.ts` (fails) and
`git merge-base --is-ancestor 38c9471 main` (false). Source worktree
`.worktrees/P17-2.1-acp-connection` (tip `38c9471`) was fully built/tested but its
branch was never actually merged into the shared `main` ref — the same "worktree
work done but not landed" gap flagged repeatedly in this repo's history (claim-store,
adapter-manager, wire-envelope-verification), each needing a dedicated `-real`/`land`
pass.

## What this task did

1. Created a fresh worktree/branch (`P17-land-2.1-acp-connection`) off current `main`
   (`cc3e9ae`), per the task's explicit instructions — not off the stale source branch.
2. Diffed the source branch's 3 commits against their own merge-base
   (`git diff --stat 487ac17 38c9471`): 7 files, 1386 insertions, all new files (no
   overlap with anything landed on `main` since — `packages/cli/src/acp/` didn't exist
   on any ancestor of current `main`).
3. Cherry-picked all 3 commits (`git cherry-pick 487ac17..38c9471`) onto the fresh
   branch — applied with zero conflicts (`ca93f9f`/`92c93d0`/`e4d38f3`). Confirmed the
   resulting tree diff against `main` (`git diff cc3e9ae..HEAD --stat`) is byte-for-byte
   identical to the original source diff — same 7 files, same 1386 insertions.
4. Re-verified on the merged tree from a clean `pnpm install --frozen-lockfile`:
   - `pnpm build` (`turbo run build --force`, cache bypassed to force real execution
     rather than trusting a replayed cache hit from another worktree) — all 6 packages
     build clean (`@falcon/wire`, `@falcon/crypto`, `@falcon/server`, `@falcon/web`,
     `falcon`, `@falcon/e2e`).
   - `pnpm typecheck` — 11/11 tasks clean.
   - `pnpm test` — 126 files / 1206 tests pass (5 more than the source worktree's
     reported 1201 — accounted for by other already-landed work now present on `main`
     that the stale source branch never saw, e.g. `commands/start.test.ts`,
     `remote/terminalStdinCleanup.test.ts`). The 20 `AcpConnection` tests are among
     them and all pass, including against the real spawned NDJSON fixture child.
   - `pnpm lint` (full repo): the harness's `rtk` shell-hook (`~/.claude/RTK.md`,
     transparently rewrites bash commands) was intercepting and mangling every biome
     invocation in this session, always surfacing the canned
     `[warn] Linter process terminated abnormally (possibly out of memory)` message —
     reproduced identically even on `biome --version` with no files at all, which
     confirmed it as a broken interception rather than a real biome/memory crash.
     Bypassed with `rtk proxy pnpm lint` (documented meta-command for exactly this).
     Full-repo lint surfaces 81 pre-existing errors / 116 warnings in files this task
     never touched (`claude/claudeRemoteLauncher.ts`, `wire/src/rpc.test.ts`, etc.) —
     confirmed pre-existing on `main` before this landing (same count reproduces on
     `HEAD~3`, i.e. `cc3e9ae`). Scoped to just the new code
     (`biome check packages/cli/src/acp/`): **0 errors, 0 warnings** — clean.
5. Did **not** merge or push the branch to the real `main` ref, and did **not** flip
   plan.md's checkbox at line 1003 — per this task's own instructions ("Only flip
   plan.md's checkbox ... after confirming `git merge-base --is-ancestor <merge-sha>
   main` is true against the real shared main ref") and the harness's explicit rule for
   this run ("Do NOT merge or push — just commit in the worktree"). The actual
   fast-forward of `main` and the plan.md checkbox flip are left to the orchestrating
   step that consumes this worktree's commit.

## Verification summary

- `pnpm build` — 6/6 packages, forced (non-cached) execution.
- `pnpm typecheck` — 11/11 clean.
- `pnpm test` — 126 files / 1206 tests passing.
- `biome check packages/cli/src/acp/` — clean (0 errors/warnings); full-repo lint debt
  (81 errors) is pre-existing on `main`, unrelated to this change.
- `git diff cc3e9ae..HEAD --stat` matches the original source diff exactly — no drift
  introduced by the cherry-pick.

## Assumptions

- The three source commits (`c9706dc`/`2e0b5db`/`38c9471`) are the correct, final
  state to land — no further changes were made to the ported code itself; this was a
  mechanical landing pass only.
- `main` will be fast-forwarded to (or merged from) this branch's tip by a later
  orchestration step, at which point `git merge-base --is-ancestor <this-branch-tip>
  main` becomes true and plan.md's checkbox can be flipped.
