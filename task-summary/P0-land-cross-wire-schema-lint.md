# P0-land-cross-wire-schema-lint — Land the wire-schema additive-only CI lint

**Section:** Cross-cutting (plan.md §16, line 807-808) / Phase 0 hardening.

## What this task did

Landed the already-complete, self-verified `P0-cross-wire-schema-lint` branch
(tip `6a31f5d`) onto `main`, which had sat unmerged across at least one prior
cycle (`plan.md`'s cycle-24 annotation confirmed `git merge-base --is-ancestor
P0-cross-wire-schema-lint main` was **not** an ancestor before this task).

1. Created worktree `.worktrees/P0-land-cross-wire-schema-lint` off `main`
   (tip `d9bfcb3`).
2. `git merge --no-ff P0-cross-wire-schema-lint` — merged cleanly, no
   conflicts (the branch's base, `f7e74f4`, was only one no-op-for-these-files
   commit behind `main`).
3. Updated `plan.md`'s cross-cutting section: replaced the stale
   "does not exist on main / stays unchecked" annotation with a landed-status
   note, and checked off `- [x] Wire-schema additive-only lint in CI (runs
   from Phase 0 onward)`.
4. **Found and fixed a real gap during landing verification**: the merged
   branch's `packages/wire/package.json` `lint:additive` script invokes the
   `tsx` CLI, but `@falcon/wire` never declared `tsx` as its own
   devDependency — the source branch's task-summary assumed it would resolve
   via "workspace-hoisted transitive `tsx` (from `pkgroll`/`vitest`)". That
   assumption is false: `pnpm --filter @falcon/wire run lint:additive` only
   worked in my shell because `tsx` happens to be installed *globally* on
   this machine (`npm ls -g` confirms `tsx@4.21.0`) — `packages/wire/node_modules/.bin/tsx`
   did **not** exist pre-fix, and a clean CI runner (`pnpm install
   --frozen-lockfile`, no global npm packages) would have failed the new CI
   step with `tsx: command not found`. Fixed by adding `"tsx": "^4.20.0"` to
   `packages/wire`'s own `devDependencies` (matching the version already used
   by `packages/cli` and `packages/server`) and re-running `pnpm install` to
   regenerate `pnpm-lock.yaml` and link `packages/wire/node_modules/.bin/tsx`.
   Re-verified `pnpm --filter @falcon/wire run lint:additive` still passes
   after the fix, using the newly-linked local binary.

## Verification (this task)

- `pnpm --filter @falcon/wire run lint:additive` → `OK — @falcon/wire is
  additive-only vs main (36 schema(s) checked)`.
- `pnpm build` → 5/5 packages, all green (turbo cache hits for unaffected
  packages, `@falcon/wire` rebuilt fresh).
- `pnpm typecheck` → 6/6 tasks green.
- `pnpm test` → 9/9 tasks green, including `packages/wire`'s
  `additiveOnly.test.ts` (38/38) and the rest of its suite (61/61 total).
- `./node_modules/.bin/biome check .` → only the same pre-existing findings
  in `packages/crypto` noted by the source branch's own task-summary (`any`
  usage, non-null assertions) — zero new findings in any file this task or
  its parent branch touched (`packages/wire/scripts/check-additive-vs-base.ts`,
  `.github/workflows/ci.yml`, `.gitignore`, `packages/wire/package.json`).
  (Ran via the local binary directly — `pnpm lint`/`npx biome` intermittently
  hit the pre-existing `[warn] Linter process terminated abnormally (possibly
  out of memory)` transient noted in this repo's `CLAUDE.md`.)
- No leftover `packages/wire/.wire-lint-*/` throwaway directories after
  running the lint (confirmed via `git status --short`).

## Files touched (beyond the merge itself)

- `plan.md` — cross-cutting section annotation + checkbox.
- `packages/wire/package.json` — added `tsx` devDependency.
- `pnpm-lock.yaml` — regenerated to include `tsx` under `packages/wire`.

## Assumptions

- Did not touch `additiveOnly.test.ts`, `schemaRegistry.ts`, `schemaShape.ts`,
  or `wire-shapes.json` — unchanged, as in the source branch.
- Did not attempt to fix the unrelated pre-existing `packages/crypto` lint
  findings — out of scope for this landing task.
- The merge commit brings in the source branch's own
  `task-summary/P0-cross-wire-schema-lint.md` unchanged (git history of that
  work); this file documents only the landing task's own work and the `tsx`
  fix discovered while landing it.
