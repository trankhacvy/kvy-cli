# P0-merge-pending-worktrees — Merge the 5 verified-but-unmerged worktree branches

## What this task was

Not a new feature — an orchestration/integration task. Two prior
progress-tracking cycles (see `progress.md` Cycle 1 and Cycle 2) found five
task worktrees with complete, self-verified implementations
(`task-summary/*.md` present in each) that had never been merged anywhere,
which meant `main` had no `package.json`/`pnpm-workspace.yaml` and every
`pnpm` command failed with `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`. This was
the sole blocker on all further Phase 0/1 work.

Per the standing rule for this worktree ("ALL file edits MUST be in
`.worktrees/P0-merge-pending-worktrees/`... Do NOT merge or push — just
commit in the worktree"), this task built the integration on a **new
branch** (`P0-merge-pending-worktrees`, checked out from `main`) rather
than merging directly onto `main`. The five source branches were merged
into *this* integration branch in the dependency order specified in the
task description; `main` itself was never touched. An orchestrator/operator
still needs to fast-forward or merge this branch onto `main` and remove the
five now-redundant source worktrees — this task only prepares and verifies
that integration.

## Merge order and outcome

1. **`P0-0.1-monorepo-scaffold`** (`809026b`) — clean, no conflicts.
   Added `package.json`, `pnpm-workspace.yaml`, `turbo.json`,
   `tsconfig.base.json`.
2. **`P0-0.1-docs-stubs`** (`34dacf1`) — clean, no conflicts (disjoint
   files: `docs/protocol.md`, `docs/encryption.md`).
3. **`P0-0.1-ci-tooling`** (`1393aa1`, already built on top of
   `809026b`) — clean, no conflicts. Added `biome.json`,
   `.github/workflows/ci.yml`, and switched root `package.json`'s `lint`
   script from `turbo run lint` to `biome check .`.
4. **`P0-0.2-wire-package`** (`6e422e4`, already built on top of
   `809026b`) — one conflict, in `pnpm-lock.yaml` only (both branches had
   independently regenerated the lockfile). Resolved by taking
   wire-package's version as an interim step; the lockfile was fully
   regenerated from scratch afterward (see below), so the interim
   resolution didn't matter.
5. **`P0-0.3-crypto-package`** (`00cd76a`) — two conflicts. This branch
   was **not** built on top of `P0-0.1-monorepo-scaffold`/`ci-tooling`
   (its merge-base with `main` is the Cycle-1 progress commit, not the
   scaffold branch); instead it had independently recreated
   `pnpm-workspace.yaml`/`turbo.json`/`tsconfig.base.json`/`package.json`
   from scratch. `pnpm-workspace.yaml`/`turbo.json`/`tsconfig.base.json`
   were byte-identical to the already-merged scaffold so those auto-merged
   without conflict; only `package.json` (crypto's copy still had the
   pre-ci-tooling `"lint": "turbo run lint"` and no `@biomejs/biome`
   devDependency) and `pnpm-lock.yaml` conflicted. Resolved by keeping the
   integration branch's `package.json` (i.e. ci-tooling's biome-based
   setup), since crypto's copy was a stale duplicate of the original
   scaffold file with no crypto-specific changes.

After all five merges, ran `pnpm install` once to regenerate
`pnpm-lock.yaml` from the final `package.json`/workspace state rather than
trust either side's independently-generated lockfile — this is the
authoritative fix for the two lockfile conflicts above.

## Post-merge validation

- `pnpm build` — green (`@falcon/crypto`, `@falcon/wire`).
- `pnpm typecheck` — green.
- `pnpm test` — green, 126 tests total (65 in `@falcon/crypto`, 61 in
  `@falcon/wire`).
- `pnpm lint` — **initially failed** (58 errors, 31 warnings). Root cause:
  `packages/wire` and `packages/crypto` were both developed in worktrees
  that branched before (or independently of) `P0-0.1-ci-tooling`'s
  `biome.json`, so their source used single-quote/loose-array formatting
  that the root Biome config (double quotes, trailing commas) flags.
  Fixed by running `biome check --write .` (`pnpm lint:fix` via
  `rtk proxy`, since the local rtk PreToolUse hook otherwise crashes
  Biome's linter process — same documented quirk as the `P0-0.1-ci-tooling`
  task summary, not a real defect). This auto-fixed formatting across 40
  files (pure reformatting — quote style, array/object wrapping — no
  logic changes). One genuine lint **error** remained after autofix:
  `packages/crypto/src/encryption.ts`'s `decryptWithDataKey` had an unused
  `error` binding in its `catch` clause; changed to a binding-less
  `catch {}` (semantically identical, still swallows and returns `null`).
  After that fix, `pnpm lint` exits 0 — the 31 remaining diagnostics are
  all `warn`-level (`noExplicitAny`, `noNonNullAssertion`,
  `noConsole`) per `biome.json`, which don't fail the check.

## `plan.md` §16 checkbox updates

- **0.1 Scaffold**: checked off "Init monorepo…" (line 614), "Biome…CI
  workflow" (line 615), and "`docs/` seeded with…stubs" (line 617).
  Left "Root `postinstall` builds `@falcon/wire` first" (line 616)
  **unchecked** — none of the five merged worktrees implemented it; both
  `P0-0.1-monorepo-scaffold`'s and `P0-0.2-wire-package`'s task summaries
  explicitly call it out as a separate, out-of-scope bullet (it's
  meaningless until `packages/wire` exists, and turbo's `dependsOn` graph
  was used instead of a hand-rolled postinstall hook — a real gap against
  the plan's literal wording that a future task should close or the plan
  should be reworded to match turbo's approach).
- **0.2 `@falcon/wire`**: all 8 sub-items checked — verified each maps to
  actual code (`box.ts`, `session.ts`, `updates.ts`, `rpc.ts`,
  `permissions.ts`, `reserved.ts`, the `additiveOnly` snapshot test) and
  all 61 wire tests pass.
- **0.3 `@falcon/crypto`**: all 7 sub-items checked — verified each maps
  to actual code (`encryption.ts`/`.web.ts`, `box.ts`/`.web.ts`,
  `keys.ts`, `dek.ts`/`.web.ts`, `recovery.ts`) and all 65 crypto tests
  pass, including cross-impl (node↔web) test vectors.

## What was intentionally not done

- Did **not** merge this integration branch into `main`, push anything, or
  remove the five source worktrees (`P0-0.1-monorepo-scaffold`,
  `P0-0.1-docs-stubs`, `P0-0.1-ci-tooling`, `P0-0.2-wire-package`,
  `P0-0.3-crypto-package`) — per this worktree's standing rule, that's an
  orchestrator action outside the scope of a single isolated task worktree.
  The `P0-merge-pending-worktrees` branch is ready to be fast-forwarded (or
  merged) onto `main`; once that happens the five source worktrees can be
  removed with `git worktree remove`.
- Did **not** touch `progress.md` — it's a log written by a separate
  progress-tracking cycle process, not something this task's instructions
  asked for.
- Did **not** implement the root `postinstall` hook or root `CLAUDE.md`
  (plan.md line 618) — both are separate, unstarted 0.1 bullets that no
  source worktree covered.

## Assumptions

- Interpreted "merge into main" (per the task's outer description) as
  "build and verify the integration on an isolated branch that an
  orchestrator will subsequently land on `main`", reconciling it with the
  worktree's explicit "do NOT merge or push" rule. If the orchestrator's
  intent was instead for this agent to directly commit the merge onto
  `main`, that step still needs to happen — this branch has everything
  needed to do it with `git merge --ff-only P0-merge-pending-worktrees`
  from `main` (all five source branches plus the lint/lockfile fixups are
  linear history on top of `main`'s current tip, `869cb31`).
- Regenerating `pnpm-lock.yaml` via `pnpm install` (rather than hand-editing
  the conflicted YAML) was treated as the correct resolution for both
  lockfile conflicts, since it's a derived file and the workspace's
  `package.json` files are the source of truth.
