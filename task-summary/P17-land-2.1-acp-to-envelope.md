# P17-land-2.1-acp-to-envelope

**Task**: Land `P17-2.1-acp-to-envelope` onto main for real.
**Section**: 17. v2 — ACP migration / Phase 2.1 — ACP core.

## What was verified broken at the start

`packages/cli/src/acp/acpToEnvelope.ts` (the `mapAcpUpdateToEnvelopes` mapper, 22 unit
tests) was fully built and reported green in worktree `P17-2.1-acp-to-envelope` (tip
`16815af`, merge-base with `main` at `ee98d78`), but:

- `git merge-base --is-ancestor 16815af main` → **false**
- `git cat-file -e main:packages/cli/src/acp/acpToEnvelope.ts` → fails, file absent

Confirmed independently before touching anything (`main` tip at start: `cc3e9ae`).

## What this pass did

1. Confirmed `ee98d78` (the worktree's merge-base) is an ancestor of current `main`
   (`cc3e9ae`) — no drift to reconcile, the source branch is a clean single commit ahead.
2. Created a **fresh** worktree/branch off current `main`:
   `git worktree add .worktrees/P17-land-2.1-acp-to-envelope -b
   P17-land-2.1-acp-to-envelope main`.
3. `git cherry-pick 16815af` — applied cleanly, zero conflicts. Added:
   - `packages/cli/src/acp/acpToEnvelope.ts` (497 lines)
   - `packages/cli/src/acp/acpToEnvelope.test.ts` (288 lines, 22 tests)
   - `task-summary/P17-2.1-acp-to-envelope.md` (the original task's own summary)
   Committed as `6f25a93` on this worktree's local branch.
4. `pnpm install` (fresh worktree, needed its own `node_modules`).
5. Re-verified on the merged tree:
   - `pnpm build` → 6/6 turbo tasks green
   - `pnpm typecheck` → 11/11 turbo tasks green
   - `pnpm test` → 11/11 turbo tasks green, 126 files / 1203 tests total, including the
     new `src/acp/acpToEnvelope.test.ts` at 22/22
6. Added a dated `plan.md` note under the Phase 2.1 `acpToEnvelope.ts` bullet documenting
   all of the above, **without flipping the checkbox to `[x]`** — see below.

## Why the checkbox is still `[ ]`

This subagent's operating rules for worktree "land" tasks are explicit: *"Do NOT merge or
push — just commit in the worktree."* Commit `6f25a93` therefore exists only on the
worktree-local branch `P17-land-2.1-acp-to-envelope`; from inside this worktree,
`git merge-base --is-ancestor 6f25a93 main` still returns **false**, because the shared
`main` ref has not actually been fast-forwarded to it.

Flipping the `plan.md` checkbox now — before `main` is actually updated — would repeat
the exact false-landing mistake already documented once in this same bullet (the
`16815af` worktree reporting green tests but never touching `main`). The real
fast-forward (or a merge commit built from this branch) plus the `git merge-base
--is-ancestor <sha> main` → true check and checkbox flip are deferred to whatever step
actually has merge/push access to `main` — the same two-step shape that closed out the
sibling `wire-envelope-verification` bullet in Phase 2.0
(`task-summary/P17-land-2.0-wire-envelope-verification.md`).

## Verification commands run

```
git merge-base --is-ancestor ee98d78 main   # true (source branch is current, no drift)
git worktree add .worktrees/P17-land-2.1-acp-to-envelope -b P17-land-2.1-acp-to-envelope main
git cherry-pick 16815af                     # clean, no conflicts
pnpm install
pnpm build                                  # 6/6 green
pnpm typecheck                              # 11/11 green
pnpm test                                   # 11/11 green, acpToEnvelope.test.ts 22/22
git merge-base --is-ancestor 6f25a93 main   # false (still, from inside this worktree)
```

## Assumptions

- `mapAcpUpdateToEnvelopes` itself is unchanged from `16815af` — this pass is a landing
  pass only, no functional edits to the mapper or its tests.
- The actual fast-forward of the shared `main` ref to this worktree's commit (or a merge
  commit built from it), and the corresponding `plan.md` checkbox flip, are out of scope
  for this subagent invocation per its explicit "Do NOT merge or push" instruction, and
  are left for a subsequent step with that access.
