# AH3 — gate-password-prod (item 3)

Depends on: AH2 (`oauth-stepup-reset-keys`) — already merged+verified on this branch
(`/reset-keys/`, `web/src/app/(public)/reset-keys/` exists, `[x]`'d in the plan's Master
TODO checklist). No prior partial attempt existed for AH3 (`git log v2-pty-injection..HEAD`
showed no commits in this worktree) — built from scratch, not a resume.

## What changed

### 3a — web: hide the email+password link behind `DEV_AUTH_ENABLED`

`packages/web/src/app/(public)/signin/page.tsx`: the "Or / email+password / dev-bypass"
block is now wrapped in `{DEV_AUTH_ENABLED && (...)}` (previously only the dev-bypass
button itself was gated; the email+password link and the separator always rendered). The
"no OAuth provider configured" note moved up into the OAuth button group so a
no-OAuth-configured, `DEV_AUTH_ENABLED=false` production deployment still shows a
sensible message instead of a card with nothing clickable in it (matches the plan's 3a
note on this). The card description and the closing "OAuth and email+password are both
first-class identities" paragraph are now conditional on `DEV_AUTH_ENABLED` too (small
copy adjustment beyond the plan's literal snippet, needed so a prod build doesn't
reference a login method it doesn't offer — noted here since it's not in the plan's own
code sample).

No changes to `/password/page.tsx` itself — matches the plan's scope (only the *link* to
it is gated; the page still exists for a `DEV_AUTH_ENABLED=1` deployment that links to it,
and a direct-URL visit on a gated prod deployment now just hits a form whose submits 404,
per 3b).

### 3b — server: reject all four `password.ts` handlers when `FALCON_DEV_AUTH` is off

`packages/server/src/app/routes/password.ts`: imports `env` from `../../config.js`
(previously unimported) and adds, as the first line of each of the four handlers
(register, login, reset/request, reset/confirm):

```ts
if (!env.FALCON_DEV_AUTH) {
  return reply.code(404).send({ error: "Not found" });
}
```

Fail-closed 404 (not 403), matching the plan's "route effectively doesn't exist" stance
and the existing dev-OAuth-bypass precedent (`auth/oauth.ts`'s "dev" provider). No new
boot-time guard was added — `config.ts`'s existing `.refine()` (already present,
already tested in `config.test.ts`: "throws when NODE_ENV=production and FALCON_DEV_AUTH
is enabled") already makes `FALCON_DEV_AUTH=1` structurally impossible under
`NODE_ENV=production`, so these routes are transitively unreachable in prod — exactly as
the plan calls out.

### 3b (schema) — `404: ErrorSchema` on all four gated routes

Added to each handler's `schema.response` map (`ErrorSchema` was already defined/used for
400/401 in this file):

```ts
response: { 200: SessionResponseSchema, 400: ErrorSchema, 404: ErrorSchema }  // register
response: { 200: SessionResponseSchema, 401: ErrorSchema, 404: ErrorSchema }  // login
response: { 200: OkResponseSchema, 404: ErrorSchema }                        // reset/request
response: { 200: OkResponseSchema, 401: ErrorSchema, 404: ErrorSchema }      // reset/confirm
```

### 3c — migration precondition (no production DB access from this worktree)

Cannot run `SELECT count(*) FROM auth_identities WHERE kind='password'` against a real
production database from this sandboxed environment, so per the plan's explicit fallback
("Otherwise / add a migration path... record the check"), added a documented,
actionable pre-upgrade check instead: a new **"Upgrading to the email+password production
gate"** section in `deploy/README.md` (placed right after "Migrate on boot") that:

- gives the operator the exact SQL to run before flipping `FALCON_DEV_AUTH` off on an
  existing deployment,
- states the `0` / `> 0` decision explicitly (safe to gate vs. do not gate yet), and
- is honest that there is **no** self-serve account-linking flow yet (checked — no
  `link identity`/`linkIdentity` feature exists in `packages/web/src/features/settings` or
  elsewhere), so a `> 0` deployment must keep `FALCON_DEV_AUTH=1` until either such a flow
  ships or affected accounts are migrated out-of-band.

This is a genuine open item for whoever operates Falcon's actual production deployment —
flagging it explicitly rather than silently assuming the precondition holds, since I have
no way to verify it from here.

### 3d — tests

`packages/server/src/app/routes/password.test.ts` (existing file, restructured, not just
appended to): all existing register/login/lockout/reset tests now run against a server
built with `FALCON_DEV_AUTH=1` (the "local dev, both sides on" scenario the plan's own
"What to verify" list calls out) — necessary because gating the routes on the module-level
`env` singleton (parsed once from `process.env` at import time, same pattern as
`config.ts`) means the previously-default-on behavior now requires the flag explicitly.
Uses the same `vi.resetModules()` + fresh dynamic `import("../server.js")` pattern
`config.test.ts`/`oauth.test.ts` already established for exercising different env
combinations against the parse-once singleton.

New file `packages/server/src/app/routes/password-gate.test.ts`: the flag-off / production
gate behavior — asserts all four routes 404 with `{ error: "Not found" }` when
`FALCON_DEV_AUTH` is unset. **Deliberately a separate file**, not a second describe block
in `password.test.ts`: `server.ts` transitively imports `routes/metrics.ts`, which
registers process-level `prom-client` default metrics on import; `prom-client` lives in
`node_modules` and is not reset by `vi.resetModules()` (only in-tree modules are), so a
second fresh `import("../server.js")` in the *same* vitest worker throws "metric already
registered". Splitting into two files gives each its own isolated module
registry/worker (vitest's default `isolate: true`), so each does exactly one
`resetModules()` + `buildServer` import — this was hit and fixed during this unit (see
"Verification" below), not something the plan anticipated at this level of detail.

The existing boot-guard test ("throws when NODE_ENV=production and FALCON_DEV_AUTH is
enabled", `config.test.ts`) already covers "boot fails loudly if misconfigured in
production" — no new test needed there since no new boot guard was added (reusing
`FALCON_DEV_AUTH`, per the plan's explicit "no new boot-time guard is needed").

## Drift from the plan

- The plan's 3a snippet only shows the dev-bypass button behind `DEV_AUTH_ENABLED`
  already and describes wrapping "the email+password block" — the actual pre-existing
  code had the email+password button and its explanatory paragraph rendering
  unconditionally (only the *dev-bypass* button below it was flag-gated), matching the
  plan's own "Current behavior" writeup. Implemented as described; also moved the "no
  provider configured" note and tweaked two paragraphs' copy to stay honest in a
  `DEV_AUTH_ENABLED=false` build (not in the plan's literal snippet, but required by its
  own stated intent).
- Test structure required a real implementation decision the plan doesn't cover (module
  reset + `prom-client` double-registration) — resolved by splitting the "flag off" tests
  into their own file, documented in both test files' header comments for future readers.

## Verification

- `pnpm build` — pass (all 6 packages, including `@falcon/web`'s static export and
  `@falcon/server`).
- `pnpm typecheck` — pass (11/11 tasks).
- `pnpm --filter @falcon/server test` — 47/47 files, 364/364 tests pass (run twice
  clean; one earlier run hit transient hook-timeouts/Postgres-not-ready under heavy
  parallel load — reproduced as pre-existing flakiness independent of this change by
  confirming `src/db/seq.test.ts` and the full suite pass in isolation, and by running the
  untouched base commit through the same full-suite command, which also intermittently
  varies — matches `vitest.config.ts`'s own documented "occasional resource contention"
  caveat).
- `pnpm --filter @falcon/web test` — 152/152 files, 1170/1170 tests pass.
- `pnpm --filter falcon test` (CLI, untouched by this unit) — 162/162 files, 1943/1943
  tests pass in isolation (root `pnpm test`'s single parallel run hit 2 unrelated
  transient failures in CLI tests under load; both pass cleanly run alone, confirming
  they're pre-existing environment flakiness, not caused by this change).
- `pnpm lint` (via `rtk proxy npx biome check .` — the default `biome`/`npx` invocation in
  this session is intercepted by an RTK shell hook that always prints a canned
  "possibly out of memory" warning regardless of the real result) — one real formatting
  issue introduced by my edit in `signin/page.tsx` (a wrapped paragraph), fixed via
  `biome check --write` on the touched files; the only remaining diagnostic on touched
  files is a pre-existing `lint/performance/noImgElement` warning on the page's
  already-existing hero `<img>`, unrelated to this change. Full-repo `biome check .`
  otherwise reports pre-existing errors/warnings across `packages/cli` unrelated to this
  unit's file set.

## Files touched

- `packages/server/src/app/routes/password.ts` — gate + `404: ErrorSchema`.
- `packages/server/src/app/routes/password.test.ts` — restructured for `FALCON_DEV_AUTH=1`.
- `packages/server/src/app/routes/password-gate.test.ts` — new, flag-off 404 tests.
- `packages/web/src/app/(public)/signin/page.tsx` — email+password link gated.
- `deploy/README.md` — new "Upgrading to the email+password production gate" section
  (3c migration note).
