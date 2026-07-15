# P0-cross-wire-schema-lint — CI lint enforcing @falcon/wire is additive-only

**Section:** Cross-cutting (continuous, no phase) — plan.md §16/"Cross-cutting":
"Wire-schema additive-only lint in CI (runs from Phase 0 onward)". Design basis:
falcon-system-design.md §5.3 — "the server can never migrate ciphertext. Every
encrypted payload carries a version; payload schemas are additive-only,
forever ... enforced by a wire-schema compat lint in CI and golden fixtures
per version."

## What was already there (0.2, not touched)

`packages/wire/src/__tests__/` already has a full snapshot-based compat
check, merged in 0.2:
- `schemaShape.ts` — `describeShape()` fingerprints a zod schema into a
  structural `ShapeDescriptor`; `isCompatible(prev, next)` checks `next` is
  a backward-compatible (additive) evolution of `prev`.
- `schemaRegistry.ts` — name -> schema map of the 36 top-level wire schemas.
- `scripts/snapshot-shapes.ts` — manually-run generator that (re)writes
  `__fixtures__/wire-shapes.json`, the frozen baseline.
- `additiveOnly.test.ts` — for every schema in the frozen fixture, asserts
  it's still exported and `isCompatible(frozen, live)`. Runs as part of
  `pnpm test` (`vitest run`), which is already a step in `.github/workflows/ci.yml`.

## The gap this task closes

`additiveOnly.test.ts` only catches a breaking change if the PR *doesn't*
also regenerate `wire-shapes.json` to match it. A PR that (a) removes/retypes
a field and (b) runs `snapshot-shapes.ts` to refreeze the fixture in the same
commit passes that test cleanly — the "frozen" baseline was silently moved to
match the breakage. **Verified this hole is real**: temporarily deleted
`EncryptedBoxSchema.c`, regenerated the fixture, reran
`additiveOnly.test.ts` — **38/38 passed**. The task asks for a lint that
"specifically gat[es] schema *changes* in CI, not just presence" — i.e. one
that can't be silenced by editing the fixture alongside the break.

## What was built

**`packages/wire/scripts/check-additive-vs-base.ts`** (new) — a CI-only lint
that re-derives the "before" state from **git history** instead of the
checked-in fixture:
1. Resolves a base ref: `$WIRE_LINT_BASE_REF` -> `origin/$GITHUB_BASE_REF`
   -> `origin/main` -> local `main` (first one `git rev-parse --verify`
   accepts). Skips (warns, exits 0) if none resolve, if the base ref has no
   `packages/wire/src`, or if it predates `__tests__/schemaRegistry.ts` —
   all logged, not silent.
2. `git archive <baseRef> -- packages/wire/src | tar -x` into a throwaway
   dir **inside** `packages/wire/` (not the system tmpdir — Node's bare
   `zod`/`@paralleldrive/cuid2` resolution from the extracted files needs to
   walk up to the repo's real `node_modules`, which only works if the
   extraction lives under the repo root). Cleaned up in a `finally`.
3. Dynamically imports the base's `schemaRegistry.ts` (via `tsx`'s loader,
   already active for the whole process) to get the actual base-branch zod
   schema instances — not a JSON description of them.
4. Runs **this branch's** `describeShape`/`isCompatible` (imported normally,
   not from the extracted copy) against both the base schemas and the live
   schemas, so the compatibility logic itself is always the current one, and
   compares base -> live. Any schema name that shipped at the base ref must
   still exist and be additively compatible on the current branch, or the
   script prints the offending schema names and `process.exitCode = 1`.

This is independent of the fixture entirely — regenerating
`wire-shapes.json` has no effect on this check's outcome, because the "prev"
state comes from `git archive`, not from disk.

**`packages/wire/package.json`** — added `"lint:additive": "tsx
scripts/check-additive-vs-base.ts"`, invoked from CI as `pnpm --filter
@falcon/wire run lint:additive` (not a raw `exec tsx`, so the script and its
CI entry point can't drift apart). The script itself still isn't declared
with its own `tsx` devDependency — it runs on the workspace-hoisted
transitive `tsx` dep (from `pkgroll`/`vitest`), same convention as the
pre-existing `scripts/snapshot-shapes.ts`.

**`.github/workflows/ci.yml`** — two new `pull_request`-only steps after
"Build @falcon/wire":
- "Fetch base branch (for wire additive-only lint)" — `git fetch --no-tags
  --depth=1 origin "$GITHUB_BASE_REF"` (depth 1 is enough; `git archive`
  only needs the tip commit's tree, not ancestry). `github.base_ref` is
  passed through an `env:` var and referenced as `"$GITHUB_BASE_REF"` in the
  shell command rather than interpolated directly into `run:`, per the
  repo's script-injection guard for untrusted/PR-controlled workflow
  context values.
- "Wire schema additive-only lint (vs base branch)" — runs `pnpm --filter
  @falcon/wire run lint:additive` (the package.json script, not a raw `exec
  tsx` of the file) with `GITHUB_BASE_REF` in `env:`.

Both steps are gated on `github.event_name == 'pull_request'` — this is a
PR-gating lint (per the task: "fails a **PR**"); on a push-to-main event
there's no meaningful "base branch" to diff against, and the existing
`additiveOnly.test.ts` fixture check still runs unconditionally via
`pnpm test`.

**`.gitignore`** — added `packages/wire/.wire-lint-*/` for the throwaway
extraction directory (defense in depth in case the script is killed before
its `finally` cleanup runs).

## Verification

- `WIRE_LINT_BASE_REF=main pnpm --filter @falcon/wire exec tsx
  scripts/check-additive-vs-base.ts` -> `OK — @falcon/wire is additive-only
  vs main (36 schema(s) checked)` (HEAD == main at time of this task, so a
  clean no-op pass).
- **Regression test**: temporarily deleted `EncryptedBoxSchema.c` from
  `box.ts` and reran with `WIRE_LINT_BASE_REF=main` -> correctly failed,
  listing 6 dependent schemas (`EncryptedBoxSchema`, `SessionRowSchema`,
  `MachineRowSchema`, `UnmanagedSessionRowSchema`, `UpdateSchema`,
  `RpcCallSchema`) with `process.exitCode = 1`.
- **Confirmed the exact gap this closes**: with the same field still
  deleted, ran `snapshot-shapes.ts` to regenerate `wire-shapes.json`, then
  reran `additiveOnly.test.ts` -> **38/38 passed** (the existing test is
  blind to a same-PR fixture rewrite), while `check-additive-vs-base.ts`
  still correctly failed against `origin/main`. Reverted `box.ts` and the
  fixture afterward; `git status` confirmed no residual diff from the
  experiment.
- `pnpm --filter @falcon/wire test` — 61/61 passed (6 files, includes the
  original `additiveOnly.test.ts`, untouched).
- `pnpm build` — all 5 workspace packages build clean.
- `pnpm typecheck` — clean (the new script lives in `scripts/`, which
  `packages/wire/tsconfig.json`'s `include: ["src/**/*.ts"]` already
  excludes from package typecheck — same as the pre-existing
  `snapshot-shapes.ts`; `tsx` transpiles it at runtime instead).
- `biome check` on every file this task touched
  (`check-additive-vs-base.ts`, `ci.yml`, `package.json`, `.gitignore`) —
  0 errors, 0 warnings. (Root `pnpm lint` reports pre-existing findings in
  `packages/crypto` unrelated to this task — not introduced here.)

## Assumptions / design decisions

- Comparing against **git history** (base branch), not the fixture, is the
  deliberate point of this task per its description ("complements the
  snapshot tests ... by specifically gating schema *changes*, not just
  presence") — the fixture-diff test and this git-diff lint are
  intentionally two independent checks with different blind spots.
- Base ref resolution falls back to local `main` for developer ergonomics
  (running the script locally without `origin` fetched), but CI always
  supplies `GITHUB_BASE_REF` from the actual PR's target branch.
- Chose `git archive` + `tar` (both present on GitHub-hosted Ubuntu and
  local macOS runners) over a second `git worktree` or a full second
  checkout — cheaper and only needs one directory's subtree, not a full
  working copy.
- Extraction directory is placed under `packages/wire/` rather than
  `os.tmpdir()` specifically because Node's CommonJS/ESM resolver for the
  base copy's bare `import "zod"` / `import "@paralleldrive/cuid2"` needs to
  walk up through real `node_modules` directories; a path outside the repo
  tree would fail to resolve those packages at runtime. Verified this
  experimentally (`require.resolve('zod', {paths:['packages/wire']})`
  succeeds; a path under `/tmp` would not).
- Did not add `tsx` as an explicit `packages/wire` devDependency — followed
  the pre-existing convention set by `scripts/snapshot-shapes.ts`, which
  also relies on the workspace-hoisted transitive `tsx` (from
  `pkgroll`/`vitest`) via `pnpm --filter @falcon/wire exec tsx`.
- No changes to `additiveOnly.test.ts`, `schemaRegistry.ts`,
  `schemaShape.ts`, or `wire-shapes.json` — those are 0.2's already-merged
  deliverable and out of this task's scope; this task only adds the
  complementary base-branch-diff check.

## Out of scope

Did not touch any other in-flight Phase 1 work, any other package, or the
existing snapshot-test infrastructure itself. Did not add a golden-fixture-
per-version mechanism (design §5.3's "golden fixtures per version" — that's
a broader, separately-scoped concern beyond a single CI compat lint).
