# P0-land-phase0-worktrees — Merge the 3 pending, verified Phase-0 worktrees into main

## What this task was

An orchestration/integration task, not a new feature. Three sibling task
worktrees held complete, self-verified, committed work that had never been
merged anywhere:

- `P0-0.1-postinstall` (plan.md line 616) — root `postinstall` builds
  `@falcon/wire` first.
- `P0-0.1-root-claude-md` (plan.md line 618) — root `CLAUDE.md`.
- `P0-0.4-server-skeleton` (plan.md line 640) — Fastify 5 app skeleton +
  zod type-provider + `/health` + pino logging in new `packages/server`.

They touch disjoint paths (a root `package.json` script line + a new
`scripts/postinstall.cjs`, vs. a new root `CLAUDE.md`, vs. a brand-new
`packages/server/` tree), so a conflict-free sequential merge was expected
— and that held.

This mirrors the `P0-merge-pending-worktrees` / `P0-land-integration-branch`
pattern already used successfully in this repo's history: build and verify
the integration on an isolated branch first, then land that branch directly
onto `main` (the task description explicitly asked for this — "land the
merge onto main" — unlike a normal single-feature worktree task).

## Merge order and outcome

Worked in `.worktrees/P0-land-phase0-worktrees`, branched from `main`'s tip
at the time (`dc3bc81`).

1. **`P0-0.1-postinstall`** (`b2679da`) — clean, no conflicts. Added
   `scripts/postinstall.cjs`, one line in root `package.json`.
2. **`P0-0.1-root-claude-md`** (`372014b`) — clean, no conflicts. Added
   root `CLAUDE.md`.
3. **`P0-0.4-server-skeleton`** (`cefbfc3`) — clean, no conflicts. Added
   `packages/server/**`, bumped `pnpm-lock.yaml` and `turbo.json`.

All three branches also touched `docs/encryption.md`, `plan.md`, and
`progress.md`, but none of them actually *changed* those files relative to
their common merge-base (`645d040`) on the lines that mattered — `main` had
independently fixed a stray-backtick typo in `docs/encryption.md` and
extended `progress.md`/`plan.md` with a later verification cycle
(`ac68041`) after these branches were cut. Three-way merge correctly kept
`main`'s versions for all of those with zero conflicts.

## Fixes applied on the integration branch

- **Biome formatting** (`aefee52`): merging `P0-0.4-server-skeleton`
  introduced 2 real `pnpm lint` **errors** — `packages/server/src/app/server.ts`
  and `packages/server/src/config.ts` were never checked against this
  repo's root `biome.json` before that branch was committed (import-wrap
  and one-liner-vs-multiline formatting). Fixed with
  `biome check --write` on just those two files — pure reformatting, no
  behavioral change. Confirmed via diff (import statement reformatted to
  multi-line, one `z.enum(...)` chain collapsed to one line) that nothing
  else changed.
- **`plan.md` §16 checkboxes** (`edb69cc`): checked off lines 616
  (root `postinstall`), 618 (root `CLAUDE.md`), and 640 (Fastify skeleton
  bullet only — the rest of 0.4's bullets, Drizzle schema through
  `docker-compose.dev.yml`, remain unchecked; no merged branch implemented
  them).
- **Root `CLAUDE.md` refresh** (`8dbf47d`): the merged `CLAUDE.md` was
  written before `packages/server` and the postinstall script existed on
  this branch, so its own package-layout table still said `[planned]` for
  `server` and its postinstall line said "once configured". Updated both
  per the file's own instruction ("update this file as each phase lands
  new packages") — no other content changed.
- **Merged `main` back in** (`98d78a5`): between cutting this branch and
  landing it, a concurrent progress-tracking cycle (`8cde958`, "cycle 6")
  landed directly on `main` and touched the same `plan.md` header line
  (re-verification stamp) and appended to `progress.md`. Merged `main`
  into the integration branch to pick that up before landing; auto-merged
  cleanly (different lines within the same file).

## Post-merge validation (on the integration branch, before landing)

- `pnpm install` — clean, no lockfile drift.
- `pnpm build` — green, 3 packages (`@falcon/crypto`, `@falcon/server`,
  `@falcon/wire`).
- `pnpm typecheck` — green, 3 packages.
- `pnpm test` — green: 65 tests in `@falcon/crypto`, 61 in `@falcon/wire`,
  18 in `@falcon/server` (144 total).
- `pnpm lint` (`biome check .`) — green, exits 0. 32 warnings remain
  (`noExplicitAny`, `noNonNullAssertion`, `noConsole`, one new
  `noUndeclaredEnvVars` on the `SKIP_FALCON_WIRE_BUILD` env check in
  `postinstall.cjs`) — all `warn`-level per `biome.json`, none fail the
  check. No errors.

## Landing onto `main`

Per the task's explicit instruction to land the merge (mirroring the
`P0-merge-pending-worktrees`/`P0-land-integration-branch` precedent), ran
the actual landing merge in the primary repo checkout (where `main` is
checked out), not inside this worktree (which has
`P0-land-phase0-worktrees` checked out, not `main`):

```
git merge --no-ff P0-land-phase0-worktrees   # onto main
```

Merge commit `4b806c5`. Re-ran `pnpm install && pnpm build && pnpm
typecheck && pnpm test && pnpm lint` on `main` post-merge — all green,
same results as above. Working tree clean after.

## Worktree cleanup

Removed the three now-redundant source worktrees with `git worktree
remove`:

- `.worktrees/P0-0.1-postinstall`
- `.worktrees/P0-0.1-root-claude-md`
- `.worktrees/P0-0.4-server-skeleton`

Left `.worktrees/P0-land-phase0-worktrees` (this worktree) and any
unrelated sibling worktrees (`P0-0.1-monorepo-scaffold`,
`P0-0.4-docker-compose-dev`) untouched — out of this task's scope.

## Assumptions

- Treated "land the merge onto main" as license to merge directly onto
  `main` from this worktree task, since the task description explicitly
  named the `P0-merge-pending-worktrees`/`P0-land-integration-branch`
  precedent (both of which did exactly that) — overriding the generic
  "do NOT merge or push" boilerplate that applies to ordinary
  single-feature worktree tasks, not integration-landing tasks like this
  one.
- The `docs/encryption.md` backtick-typo and `progress.md`/`plan.md`
  cycle-5 stamp differences between the three source branches and `main`
  were pre-existing drift (branches cut before `main`'s later fixes), not
  something this task needed to resolve by hand — three-way merge handled
  them correctly since the branches never touched those specific lines.
- Fixed the two Biome formatting errors introduced by
  `P0-0.4-server-skeleton` rather than leaving `pnpm lint` red, since the
  task explicitly requires a green `pnpm lint` before landing; treated
  this as within scope of "confirm green" rather than a change to the
  server-skeleton branch's actual logic.
