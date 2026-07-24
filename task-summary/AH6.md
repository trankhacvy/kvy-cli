# AH6 — Capture & store email from Google/GitHub sign-in

Plan reference: `docs/auth-ux-hardening-plan.md` §6 (lines 1130-1361).

No prior attempt existed for this unit (`git log v2-pty-injection..HEAD --oneline` was
empty at the start) — built from scratch, following the plan's snippets with the
adaptations noted below.

## What changed

1. **`packages/server/src/auth/oauth.ts`** — widened `OAuthIdentity` with
   `email: string | null` and `emailVerified: boolean` (plan 6a).
   - `verifyGoogleIdToken` now reads the `email`/`email_verified` OIDC claims straight
     out of the already-verified ID token — no extra network call (plan 6b).
   - `verifyGithubAccessToken` gained a second injectable fetcher, `fetchEmails`
     (mirroring the existing `fetchUser` injection point), calls GitHub's
     `/user/emails`, and picks the primary (falling back to any verified) address
     (plan 6c). Factored `defaultFetchUser`/`defaultFetchEmails` out as named consts
     per the plan.
   - **Adaptation over the plan's snippet:** wrapped the `fetchEmails` call in its own
     try/catch, not just an `if (emailsRes.ok)` check. The plan's own prose says
     "`/user/emails` failing … degrades to `email: null` … rather than failing the
     whole login," but its code snippet left a *rejecting* `fetchEmails` promise
     (network error, not just a bad status) to propagate up into the outer catch —
     which returns `null` for the whole identity, failing the sign-in outright. Since
     that contradicts the stated design intent, I added the inner try/catch so a
     `fetchEmails` throw degrades exactly like a `fetchUser`-successful/`fetchEmails`-
     non-2xx response does. Covered by a dedicated test (see below).
   - `verifyDevProof` returns `email: null, emailVerified: false` for the widened
     interface (plan 6d).

2. **`packages/web/src/lib/oauth.ts`** — `beginGithubSignIn`'s scope is now
   `"read:user user:email"` (plan 6c).

3. **`packages/server/src/app/routes/oauth.ts`** — the register handler now:
   - Inserts `email`/`emailVerified` on the first-sign-in `authIdentities` row.
   - Backfills `email`/`emailVerified` onto a *returning* identity only when its
     `email` column is currently empty — never overwrites an already-set email
     (plan 6e, and the §6g caveat: this "fill-when-empty" rule is intentionally
     conservative and is *not* sufficient once account-linking is built on top of
     captured emails; a linking implementation must revisit it, not build on it
     as-is).

4. **Read path (sub-task 4, plan §6f)** — the plan flagged item 6 as otherwise
   write-only and asked me to choose explicitly. There is no `GET /v1/auth/me` or
   account-summary endpoint in this codebase at all (verified: no route under
   `packages/server/src/app/routes/` besides the existing per-session
   `GET /v1/auth/sessions`), so I extended that endpoint's response with a
   top-level `email: string | null` field — resolved by looking up the caller's
   `auth_identities` row for `request.accountId` (today there is exactly one per
   account; no cross-provider linking exists yet, matching the plan's own note in
   §6g). This covers both OAuth and password identities uniformly, since
   `routes/password.ts` already writes `email`/`emailVerified` on password sign-up
   too.
   - `packages/web/src/lib/api.ts`'s `listDeviceSessions` return type gained the
     `email` field.
   - `packages/web/src/features/settings/components/DevicesSection.tsx` (Settings →
     Devices, the only screen that already calls this endpoint) now shows
     "Signed in as `<email>`." above the device list when an email is on file,
     falling back to the existing copy when it isn't. No new route, no new web
     surface — reused the existing authenticated fetch this screen already made.

5. **Tests** (all offline via injected fetchers — no network):
   - `packages/server/src/auth/oauth.test.ts` — Google: asserts the widened identity
     shape on the happy path, a verified-email capture test, and an
     unverified-email-stored-but-flagged test. GitHub: a verified-primary-email test,
     an unverified-primary-email-stored-but-flagged test, and two degrade-to-null
     tests (non-2xx `/user/emails`, and a *rejecting* `fetchEmails` — the case my
     inner try/catch adaptation covers). Existing tests updated for the new fields.
   - `packages/server/src/app/routes/oauth.test.ts` — `fakeVerifier` extended to
     encode optional `:<email>:verified|unverified` proof segments; new tests assert
     email persists on insert, an unverified email is stored but flagged false, and
     the backfill rule (fills an empty column on a returning identity, then never
     overwrites it on a later login with a different email).
   - `packages/server/src/app/routes/sessionsAdmin.test.ts` — two new tests: `email`
     is `null` when the account has no `auth_identities` row, and `email` surfaces
     the captured value when one exists.

## Verification

- `pnpm build` — passes (all 6 packages).
- `pnpm typecheck` — passes (all packages).
- `pnpm --filter @falcon/server test` — 371/371 passing (oauth.test.ts: 24, routes/
  oauth.test.ts: 10, routes/sessionsAdmin.test.ts: 6, all including the new cases).
- `pnpm --filter @falcon/web test` — 1170/1170 passing.
- `biome check` on every file this unit touched — clean (no errors/warnings). Note:
  a full-repo `pnpm lint` intermittently hit the documented
  "[warn] Linter process terminated abnormally (possibly out of memory)" transient
  (this machine was under heavy concurrent load from other agents/worktrees at the
  time — confirmed via `vm_stat` showing very low free memory, unrelated to this
  change) and once succeeded fully, surfacing only pre-existing errors/warnings in
  `packages/cli/**` — files this unit never touches (confirmed via `git status`).
- No `@falcon/wire` changes — this unit never touched that package.
- No raw refresh token / long-lived credential was moved to the main thread or
  sessionStorage; nothing in this unit interacts with credential custody at all.

## Files changed

- `packages/server/src/auth/oauth.ts`
- `packages/server/src/auth/oauth.test.ts`
- `packages/server/src/app/routes/oauth.ts`
- `packages/server/src/app/routes/oauth.test.ts`
- `packages/server/src/app/routes/sessionsAdmin.ts`
- `packages/server/src/app/routes/sessionsAdmin.test.ts`
- `packages/web/src/lib/oauth.ts`
- `packages/web/src/lib/api.ts`
- `packages/web/src/features/settings/components/DevicesSection.tsx`
