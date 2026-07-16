# P1-land-1.3-session-bootstrap

**Task:** Land the complete, self-verified `packages/cli/src/session/` work from
worktree `.worktrees/P1-1.3-session-bootstrap` (tip `fd673bd`) onto this task's own
`main`-derived worktree, `.worktrees/P1-land-1.3-session-bootstrap`.

## What was done

1. Created the landing worktree (`git worktree add .worktrees/P1-land-1.3-session-bootstrap
   -b P1-land-1.3-session-bootstrap main`) — `main` had no `P1-land-1.3-session-bootstrap`
   worktree yet.
2. Read the source worktree's commit (`fd673bd`) and diffed it against `main`'s current
   state to confirm every dependency `bootstrap.ts`/its tests assume is already present
   and unchanged on `main`:
   - `POST /v1/sessions` (`packages/server/src/app/routes/sessions.ts`) — same request
     body shape (`tag`, `provider`, `workspaceId`, `machineId`, `executionTarget?`,
     `metadata`, `dek`) and 200/201 `SessionRowSchema` response, idempotent on
     `(accountId, tag)`.
   - `@falcon/crypto`'s `wrapDek`/`unwrapDek`/`seal`/`open`/`getRandomBytes`/base64
     helpers and the `BoxKeyPair` type — all still exported from `packages/crypto/src/index.ts`
     exactly as the source branch used them.
   - `@falcon/wire`'s `SessionRowSchema`/`SessionRow`.
   - `packages/server/src/app/routes/testHelpers.ts` (`createTestDb`, `createTestAccount`,
     `RecordingEventRouter`) and `buildServer`'s `(opts, { db, oauthVerifier, eventRouter })`
     signature — both already on `main`, matching what `bootstrap.integration.test.ts`
     imports.
   No drift since the source branch was cut — this was a clean copy, not a reconciliation.
3. Copied the three new, self-contained files verbatim into this worktree:
   `packages/cli/src/session/bootstrap.ts`, `bootstrap.test.ts`,
   `bootstrap.integration.test.ts`.
4. Applied the source commit's two small config deltas by hand (not a lockfile copy —
   `main`'s dependency graph has moved on since `fd673bd` was cut, e.g. many more `cli`
   files/deps have landed):
   - `packages/cli/package.json`: added `@falcon/crypto: workspace:*` to
     `dependencies`, `@falcon/server: workspace:*` to `devDependencies`.
   - `packages/cli/tsconfig.json`: added `"exclude": ["src/session/bootstrap.integration.test.ts"]`
     so `tsc --noEmit` doesn't try to typecheck a test file that pulls in `@falcon/server`'s
     `drizzle-orm`/`@electric-sql/pglite` deps this package never declares (vitest still
     picks it up independently via its own `include` glob).
5. Ran `pnpm install` (not a manual lockfile edit) to regenerate `pnpm-lock.yaml` fresh
   against `main`'s current dependency graph.
6. Verified:
   - `pnpm build` — 5/5 tasks green (forced, no cache).
   - `pnpm typecheck` (`turbo run typecheck`) — 8/8 tasks green (forced, no cache).
   - `pnpm test` (`turbo run test`, forced, no cache): 9 tasks total. One flaky run showed
     3 `@falcon/server` suites (`auth.test.ts`, `machines.test.ts`, `sessions.test.ts`)
     failing on a `beforeAll` hook timeout — this only happens when every package's vitest
     run races in parallel under turbo, spinning up many concurrent in-memory `PGlite`
     instances that starve each other for CPU. Re-ran with `pnpm test --force
     --concurrency=1`: all 9/9 tasks green. Independently ran `@falcon/server` and `falcon`
     (cli) each in isolation via `npx vitest run`: 140/140 and 196/196 respectively, 0
     failures — confirming the parallel-run failure was pre-existing turbo/PGlite resource
     contention, not a regression introduced by this change. `session/bootstrap.test.ts`
     (13 tests) and `session/bootstrap.integration.test.ts` (2 tests) both pass in every
     run, isolated or not.
7. Flipped plan.md §1.3's "Session bootstrap" checkbox to `[x]` and appended a landing
   note in the same style as the file's other `P1-land-*` entries, documenting exactly
   what was verified and the sandboxing caveat below.

## Sandboxing caveat

Per this task's own rules ("ALL file edits MUST be in the worktree... do NOT merge or
push"), everything above happened only inside `.worktrees/P1-land-1.3-session-bootstrap`
on its own `P1-land-1.3-session-bootstrap` branch (based on `main`'s tip `a7bbceb`).
Fast-forwarding or `--no-ff` merging this branch onto the shared `main` ref from the
primary, non-worktree checkout is a follow-up step outside this subagent's write access
— the same pattern every other `P1-land-*` task in this repo's history has followed
(see plan.md's own narrative for `P1-land-1.5-ensure-daemon-running`,
`P1-land-1.5-notify-daemon-session-started`, etc.).

## Files changed in this worktree

- `packages/cli/src/session/bootstrap.ts` (new, copied from `P1-1.3-session-bootstrap`)
- `packages/cli/src/session/bootstrap.test.ts` (new, copied)
- `packages/cli/src/session/bootstrap.integration.test.ts` (new, copied)
- `packages/cli/package.json` (added `@falcon/crypto` dep, `@falcon/server` devDep)
- `packages/cli/tsconfig.json` (added `exclude` for the integration test)
- `pnpm-lock.yaml` (regenerated via `pnpm install`, not copied)
- `plan.md` (§1.3 "Session bootstrap" checkbox flipped to `[x]` + landing note)

## Assumptions

- No other in-flight worktree touches `packages/cli/src/session/` — confirmed by
  grepping every other `.worktrees/P1-1.3-*` and `.worktrees/P1-land-*` sibling for
  a `session/` directory; none exists outside the source branch this task landed from.
- `pnpm-lock.yaml` is safe to regenerate via `pnpm install` rather than hand-merging the
  source branch's 6-line lockfile diff, since `main`'s dependency graph has advanced
  materially since `fd673bd` was cut (many more `cli` deps/files landed in the interim).
