# P0-land-0.4-auth-routes

**Section:** Phase 0 — 0.4 Server foundation (§3.2, §4)
**Type:** Integration merge (no new product code) — reconciles and lands the three
route-level 0.4 worktrees onto `main`

## Context

Three completed, self-verified worktrees implemented the last three unchecked 0.4
bullets but none was merged into `main`:

- `P0-0.4-auth-challenge-route` (tip `5ca36a4`): `POST /v1/auth` Ed25519
  challenge/response + account upsert by `signPublicKey`.
- `P0-0.4-oauth-signin-routes` (tip `9eef49c`): `POST /v1/auth/register` OAuth
  Google/GitHub sign-in binding `oauthProvider`/`oauthSubject`. Built serially on top
  of `auth-challenge-route`'s commits (merge-base `c9823c4`).
- `P0-0.4-pairing-endpoints` (tip `c954ac5`): `POST/GET /v1/auth/pair*` device-linking
  with `expiresAt` TTL. Branched independently from an earlier point in the 0.4
  integration history (merge-base with `main` is `03ff892`, vs. the other two's
  `c9823c4`).

## What this did

1. Created worktree `.worktrees/P0-land-0.4-auth-routes` on new branch
   `P0-land-0.4-auth-routes`, based on current `main` tip `fad6f3e`.
2. Merged the three branches in dependency order:
   - `git merge --no-ff P0-0.4-auth-challenge-route`. Conflicts:
     - `CLAUDE.md` package-layout table: combined the branch's `@falcon/server`
       auth-route description with `main`'s already-landed `@falcon/web`
       (Next.js PWA) description — both had edited the same table but different rows.
     - `packages/server/src/config.ts`: pure line-wrap/formatting diff on the same
       `EnvSchema` fields (`LOG_LEVEL`/`DATABASE_URL` and the `.refine()` call) —
       content identical, kept `main`'s formatting.
     - `pnpm-lock.yaml`: regenerated via `pnpm install` rather than hand-resolved
       (adds `@falcon/crypto` workspace dep, `tweetnacl`, `@electric-sql/pglite` to
       `packages/server`).
   - `git merge --no-ff P0-0.4-oauth-signin-routes` — clean, no conflicts (this
     branch is a strict descendant of `auth-challenge-route`, already merged).
   - `git merge --no-ff P0-0.4-pairing-endpoints` — one conflict in
     `packages/server/src/app/server.ts`: both the oauth-signin-routes chain and the
     independently-branched pairing-endpoints branch added imports and
     `app.register(...)` calls at the same lines. Resolved by keeping all three route
     registrations, in this order: `buildAuthRoutes` (`/v1/auth`), `buildOAuthRoutes`
     (`/v1/auth/register`), `pairRoutes` (`/v1/auth/pair`, `/v1/auth/pair/status`,
     `/v1/auth/pair/approve`) — no path overlap between any of them, so ordering is
     cosmetic. `packages/server/package.json`, `pnpm-lock.yaml`, `plan.md`, and
     `packages/server/src/db/migrate.ts` (the pairing branch's advisory-lock fix for
     concurrent `runMigrations()` callers) auto-merged clean.
3. Rewrote plan.md's 0.4 section verification note to describe the actual merge
   order/conflicts above, checked off all three remaining bullets plus
   `docker-compose.dev.yml` (already checked), and checked off the Phase 0 exit
   criterion ("a script can register an account, pass the challenge, and get a JWT
   against a local server") — now satisfied by `POST /v1/auth` (challenge/response)
   + `POST /v1/auth/register` (OAuth) + the pairing routes, all present on `main`.
4. Verified: `pnpm build`, `pnpm typecheck`, `pnpm test` all green (9/9 turbo tasks;
   `@falcon/server` 87/87 tests, including the Postgres-backed `pair.test.ts` and
   `seq.test.ts` integration suites against a local Postgres reachable at
   `postgres://falcon:falcon@localhost:5432/falcon`).

## Assumptions / notes

- No route-path collisions existed between the two branch lineages, so the
  `server.ts` conflict was a pure "keep both" resolution — no route design decisions
  were made here.
- `pairRoutes` uses the module-level `db` singleton (`../../db/client.js`) directly
  rather than the dependency-injection pattern `buildAuthRoutes`/`buildOAuthRoutes`
  use for testability; this predates this task (from the `pairing-endpoints` branch)
  and was left as-is — `pair.test.ts` instead skips itself when no real Postgres is
  reachable, matching `seq.test.ts`'s existing pattern. Not in scope for this landing
  task to change.
- Per instructions, this task does **not** merge/fast-forward the integration branch
  onto `main` or push — that remains a subsequent "land" step, same as prior 0.4
  integration branches in this history (`P0-land-0.4-worktrees-onto-main`,
  `P0-land-0.4-worktrees-final`).
