# P17-land-2.0-wire-envelope-verification

**Task**: Actually land `wire-envelope-verification` onto main (fix repeated false landing).
**Section**: 17. v2 — ACP migration / Phase 2.0 — foundation.

## What was actually broken

Two prior attempts built and green-tested the same content but never touched the shared
`main` ref, both confirmed false at the start of this task:

- `P17-2.0-wire-envelope-verification` (tip `83826d5`): added the three golden fixtures,
  reported green in its own worktree. `git merge-base --is-ancestor 83826d5 main` → false.
- `P17-land-2.0-wire-envelope-verification-real` (tip `ed8024e`, branched off `main` at
  `1707258`): cherry-picked `83826d5` cleanly, re-verified green, and even flipped
  `plan.md`'s checkbox to `[x]` with a landing note — but that flip, like the fixtures
  themselves, was committed only on its own worktree-local branch. `main` was never
  fast-forwarded, so the "landed" note was itself a false claim.
  `git merge-base --is-ancestor ed8024e main` → false.

## What this pass did

1. Verified current `main` tip: `487ac17` (past the claim-store-real and
   adapter-manager-real fast-forwards from cycle 74; still missing the wire-envelope
   fixtures).
2. Created a **fresh** worktree/branch off that current `main` tip:
   `git worktree add .worktrees/P17-land-2.0-wire-envelope-verification -b
   P17-land-2.0-wire-envelope-verification main`.
3. Checked for drift before touching anything: `git diff 487ac17 83826d5~1 --
   packages/web/src/sync/reducer/golden.test.ts` was empty — `main`'s copy of the one
   file the fixture commit touches besides new files is byte-identical to `83826d5`'s
   parent, so a cherry-pick could not silently drop or reorder anything.
4. `git cherry-pick -n 83826d5` — applied cleanly, zero conflicts. Staged: the three
   `trace_acp_*.json` fixtures under `packages/web/src/sync/reducer/__testdata__/`, the
   `golden.test.ts` docstring addition (9 lines documenting why the fixtures double as
   the wire-schema-sufficiency proof), and the original task's own `task-summary/
   P17-2.0-wire-envelope-verification.md`.
5. Committed as `521d92b` on this worktree's branch.
6. Re-ran the full workspace suite on the merged tree:
   - `pnpm install` (lockfile unchanged, fresh worktree needed its own `node_modules`)
   - `pnpm build` → 6/6 turbo tasks green
   - `pnpm typecheck` → 11/11 turbo tasks green
   - `pnpm test` → 11/11 turbo tasks green; `packages/web`'s `golden.test.ts` specifically
     shows 10/10 (the pre-existing "finds at least one fixture" assertion + 9 fixture
     files, 6 pre-existing + 3 new ACP ones).
7. Added a dated `plan.md` note under the Phase 2.0 bullet documenting all of the above,
   **without flipping the checkbox to `[x]`** — see "Why the checkbox is still `[ ]`"
   below.

## Why the checkbox is still `[ ]`

This subagent's own operating rules for worktree tasks are explicit: *"Do NOT merge or
push — just commit in the worktree."* Commit `521d92b` therefore exists only on the
worktree-local branch `P17-land-2.0-wire-envelope-verification`; from inside this
worktree, `git merge-base --is-ancestor 521d92b main` still returns **false**, because
`main` has not actually been fast-forwarded to it.

Flipping the `plan.md` checkbox to `[x]` at this point — before the shared `main` ref is
actually updated — would repeat the exact mistake `ed8024e` made (claiming "landed" from
inside a worktree that was never merged). That is precisely the failure mode this task
was created to fix, so it is not repeated here: the note left in `plan.md` records that
the content is verified, conflict-free, and ready, and that the checkbox flip (plus a
`git merge-base --is-ancestor <sha> main` → true check run against the *real* `main`
ref) is deferred to whatever step actually has merge/push access — the same two-step
shape (worktree commit now, real fast-forward + doc-flip as a separate, later step) that
the claim-store and adapter-manager bullets above this one show already worked for.

## Verification commands run

```
git merge-base --is-ancestor 83826d5 main   # false (before this pass)
git merge-base --is-ancestor ed8024e main   # false (before this pass)
git diff 487ac17 83826d5~1 -- packages/web/src/sync/reducer/golden.test.ts   # empty (no drift)
git cherry-pick -n 83826d5                  # clean, no conflicts
pnpm build                                  # 6/6 green
pnpm typecheck                              # 11/11 green
pnpm test                                   # 11/11 green, golden.test.ts 10/10
```

## Assumptions

- No `@falcon/wire` schema changes were needed or made — this task is a verification-only
  proof (golden fixtures showing every ACP `session/update` kind maps onto an existing
  `SessionEnvelope` variant), matching the original task's own scope and this section's
  plan.md bullet text ("assert via golden fixtures rather than schema change").
- The actual fast-forward of the shared `main` ref to this worktree's commit (or a merge
  commit built from it) is out of scope for this subagent invocation per its explicit
  "Do NOT merge or push" instruction, and is left for a subsequent step with that access.
