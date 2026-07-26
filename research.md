# Falcon Auth Flow — Complete Research Notes

> Written in simple English. Short sentences. Many tables and diagrams.
> Every claim points to a real file, so you can go and read the code yourself.
>
> Source of truth: the code in `packages/{server,cli,web,crypto}` as of this branch.
> Design background: `docs/issue-4-plan.md`, `falcon-system-design.md` §5, `docs/auth-ux-hardening-plan.md`.

---

## Table of contents

1. [The one big idea](#1-the-one-big-idea)
2. [The cast: who talks to who](#2-the-cast-who-talks-to-who)
3. [Vocabulary (read this first)](#3-vocabulary-read-this-first)
4. [The key hierarchy (how encryption keys are made)](#4-the-key-hierarchy-how-encryption-keys-are-made)
5. [Database tables](#5-database-tables)
6. [Tokens: access token and refresh token](#6-tokens-access-token-and-refresh-token)
7. [All server endpoints](#7-all-server-endpoints)
8. [Flow A — Sign up with email + password](#flow-a--sign-up-with-email--password)
9. [Flow B — Sign in with email + password (returning user)](#flow-b--sign-in-with-email--password-returning-user)
10. [Flow C — Sign in with Google / GitHub](#flow-c--sign-in-with-google--github)
11. [Flow D — Binding keys to the account (`keys/bind`)](#flow-d--binding-keys-to-the-account-keysbind)
12. [Flow E — Pairing the CLI (`falcon auth login`)](#flow-e--pairing-the-cli-falcon-auth-login)
13. [Flow F — Page reload: PIN unlock + silent refresh](#flow-f--page-reload-pin-unlock--silent-refresh)
14. [Flow G — WebSocket authentication and in-band renew](#flow-g--websocket-authentication-and-in-band-renew)
15. [Flow H — Logout and device revocation](#flow-h--logout-and-device-revocation)
16. [Flow I — Forgot PIN → reset keys (rotate epoch)](#flow-i--forgot-pin--reset-keys-rotate-epoch)
17. [Flow J — Password reset](#flow-j--password-reset)
18. [Flow K — CLI daily life (daemon + session)](#flow-k--cli-daily-life-daemon--session)
19. [Where every secret lives](#19-where-every-secret-lives)
20. [Attacks and defenses](#20-attacks-and-defenses)
21. [What breaks, and what the user sees](#21-what-breaks-and-what-the-user-sees)
22. [Sharp edges and gotchas](#22-sharp-edges-and-gotchas)
23. [File map](#23-file-map)

---

## 1. The one big idea

Falcon splits authentication into **two separate things**. If you remember only one
sentence from this document, remember this one:

> **Identity** (who you are) and **key custody** (who can read your data) are
> completely separate systems. They meet only once — at `keys/bind`.

| | Identity | Key custody |
|---|---|---|
| Question it answers | "Is this really you?" | "Can this device read your encrypted data?" |
| Proof | email+password, or Google, or GitHub | holding the 32-byte `masterSecret` |
| Who checks it | the server | nobody — the server has no keys |
| Stored where | `auth_identities` table (argon2id hash / provider id) | client only (browser IndexedDB, CLI `~/.falcon/access.key`) |
| If you lose it | reset password by email | **your old encrypted data is gone forever** |
| Code | `server/src/app/routes/{password,oauth}.ts` | `crypto/src/*`, `web/src/crypto/*`, `cli/src/auth/*` |

Why this split matters:

- Losing your **PIN** does **not** lose your account. You can still log in. You just
  cannot read old encrypted sessions any more.
- Losing your **password** does not lose your keys. Your browser still has the wrapped
  master secret in IndexedDB.
- The server can never read your session content. It stores ciphertext (`bytea` columns)
  and relays it. See `packages/server/src/db/schema.ts:21` — the `bytea` custom type
  docblock says this explicitly.

Before `docs/issue-4-plan.md` these two were fused into one key. That old model is gone.
There is no "recovery code" any more.

---

## 2. The cast: who talks to who

```
                    ┌──────────────────────────────────────┐
                    │        @falcon/server (Fastify)      │
                    │   • mints + verifies JWTs            │
                    │   • stores ciphertext, never keys    │
                    │   • Socket.IO at /v1/stream          │
                    └───────┬──────────────────┬───────────┘
                            │ HTTPS + WS       │ HTTPS + WS
                            │                  │
             ┌──────────────┴─────┐     ┌──────┴───────────────┐
             │  @falcon/web (PWA) │     │  falcon CLI          │
             │  Next.js static    │     │  daemon + session    │
             │                    │     │                      │
             │  crypto Worker ◄───┼─────┼──► ~/.falcon/        │
             │  + IndexedDB       │pair │    access.key        │
             │  (PIN-wrapped)     │     │    (device-key wrap) │
             └────────────────────┘     └──────────────────────┘
                        ▲
                        │ approve
                   the human
```

Three client kinds exist in the JWT (`packages/server/src/auth/tokens.ts:20`):

| `clientKind` | Who | Minted where | Actually used today? |
|---|---|---|---|
| `web` | browser | `routes/password.ts`, `routes/oauth.ts` | ✅ yes |
| `cli-daemon` | the `falcon` daemon | `app/api/pair.ts` (`/pair/mint`) | ✅ yes |
| `cli-session` | a single `falcon claude` run | — | ❌ declared, never minted. `falcon claude` reuses the daemon's refresh token from `access.key`. |
| `cloud-sandbox` | future feature | — | ❌ not built |

---

## 3. Vocabulary (read this first)

| Term | Simple meaning | Size / shape | Lives where |
|---|---|---|---|
| **account** | one human's account | cuid2 string | `accounts` table |
| **auth identity** | one way to log in (password / google / github). One account can have several. | row | `auth_identities` |
| **device session** | one logged-in device. Web tab = one. CLI daemon = one. | row | `device_sessions` |
| **access token** | short JWT you attach to every request | JWT, **15 minutes** | memory only (never on disk) |
| **refresh token** | long random secret used to get new access tokens | 32 random bytes → base64url, **60 days** | PIN-wrapped (web) / device-wrapped (CLI). Server stores only its SHA-256 hash. |
| **masterSecret** | the root of all encryption | **32 random bytes** | client only, always wrapped at rest |
| **keyTree** | 4 things derived from masterSecret | see §4 | worker memory / CLI process memory |
| **PIN** | what protects the masterSecret in the browser | ≥ 6 characters | never stored, only in worker memory while unlocked |
| **DEK** | data encryption key, one per session/machine/workspace | 32 bytes, AES-256-GCM | stored wrapped in the `dek` column |
| **keyEpoch** | version number of your key material | integer: 0 = none, 1 = first bind, +1 per rotate | `accounts.key_epoch` |
| **ephPub** | throwaway X25519 public key the CLI makes for one pairing attempt | 32 bytes | never saved |
| **step-up** | proving it's really you again, right before a dangerous action | password re-entry or a fresh OAuth proof | — |

---

## 4. The key hierarchy (how encryption keys are made)

File: `packages/crypto/src/keys.ts`

```
masterSecret (32 random bytes, made in the browser by getRandomBytes(32))
     │
     │  HMAC-SHA512(key = "<label> Master Seed", data = masterSecret) → first 32 bytes
     │
     ├── label "falcon-auth"        → ed25519 signing keypair
     │                                 → used ONLY to sign the keys/bind challenge
     │
     ├── label "falcon-content"     → x25519 content keypair
     │                                 → wraps and unwraps every DEK
     │
     ├── label "falcon-anon"        → anonId (16 hex chars) for analytics
     │
     └── label "falcon-blob-master" → legacy global blob key (rarely used)

Separately, from a DEK (not from masterSecret):
DEK ── label "falcon-blobs" → blob key   (crypto/src/keys.ts:84 deriveBlobKey)
```

Then, per row of data:

```
session row / machine row / workspace row
   ├─ dek column   = [0x00 | sealed_box(contentPubKey, DEK)]   ← crypto/src/dek.ts
   ├─ metadata     = EncryptedBox = AES-256-GCM(DEK, json)     ← crypto/src/box.ts
   └─ messages     = EncryptedBox                              ← same
```

The important property: the server stores `dek` and `metadata` as opaque bytes. It has
no content secret key, so it can unwrap nothing. `unwrapDek` returns `null` (never
throws) if the wrong key is used — `packages/crypto/src/dek.ts:30`.

**Derivation is deterministic.** Same masterSecret → same signing key, always. That is
why the CLI can show your "Account key" fingerprint offline (`cli/src/auth/status.ts:56`).

---

## 5. Database tables

All in `packages/server/src/db/schema.ts`.

### `accounts` (line 31)
| Column | Meaning |
|---|---|
| `id` | cuid2 |
| `sign_public_key` | hex ed25519 public key. **nullable** — null until first `keys/bind`. Unique. |
| `content_pub_key` | base64 x25519 public key, used by everyone to wrap DEKs for you |
| `key_epoch` | 0 = no keys bound, 1 = first bind, +1 each rotation |
| `settings` | encrypted blob |
| `notifications_muted_all` | plaintext on purpose — push dispatcher must read it without keys |

### `auth_identities` (line 50)
| Column | Meaning |
|---|---|
| `kind` | `'password'` \| `'google'` \| `'github'` |
| `identifier` | lowercased email (password) or provider user id (oauth) |
| `password_hash` | argon2id PHC string, null for oauth |
| `email`, `email_verified` | best-effort display only, never an auth gate |
| `failed_login_count`, `locked_until` | per-identity lockout (see Flow B) |
| unique index | `(kind, identifier)` |

### `device_sessions` (line 79) — the heart of session management
| Column | Meaning |
|---|---|
| `id` | goes into the JWT as `sid` |
| `refresh_token_hash` | SHA-256 of the current refresh token. **Unique.** Raw token never stored. |
| `previous_refresh_token_hash` + `previous_rotated_at` | the last rotation. This pair is how theft is detected. |
| `family_id` | random uuid. All rotations of one login share it. Theft kills the whole family. |
| `client_kind` | `web` / `cli-daemon` / … |
| `machine_id` | backfilled later by `POST /v1/machines`, used for "this machine needs re-login" |
| `expires_at` | **absolute** 60 days from creation. Not sliding. |
| `revoked_at` | non-null = dead |

### `key_bind_nonces` (line 104)
Single-use, 120-second nonces the server mints for `keys/challenge`. Stops replay.

### `password_reset_tokens` (line 117)
Single-use, 1-hour reset tokens. Points at an **identity**, not an account — resetting a
password does not touch your Google identity on the same account.

### `pair_requests` (line 237)
| Column | Meaning |
|---|---|
| `eph_pub` | the CLI's ephemeral X25519 public key, base64. **Unique** — this is the lookup key. |
| `state` | `pending` \| `authorized` \| `expired` |
| `response` | the sealed box `[0x01 \| masterSecret \| refreshToken]`. **The only secret this table ever holds, and the server cannot open it.** |
| `expires_at` | hard 15-minute TTL |

Note the schema comment at line 220–236: there used to be a **plaintext** refresh-token
column here. It was removed. A stolen database dump would have contained live credentials.

---

## 6. Tokens: access token and refresh token

### 6.1 Access token — `packages/server/src/auth/tokens.ts`

- Algorithm: **HS256** (symmetric). One secret: `FALCON_MASTER_SECRET` (min 32 chars,
  and the server refuses to boot in production with the dev default —
  `server/src/config.ts:177`).
- Why not RS256? Single server, mints and verifies its own tokens. Nothing else needs to
  verify without the secret. The docblock at `tokens.ts:4` explains it.
- TTL: **15 minutes** (`ACCESS_TOKEN_TTL_SECONDS`).

Claims:

```json
{
  "sub": "<accountId>",       // who
  "sid": "<deviceSessionId>", // which device session  ← needed for per-device revoke
  "ct":  "web",               // client kind
  "iat": 1700000000,
  "exp": 1700000900
}
```

`verifyToken()` returns `null` — never throws — for **any** problem: bad signature,
expired, wrong secret, malformed, or **missing `sid`/`ct`**. A token minted before
issue-4 has no `sid`, so it is rejected. This is deliberate: reject, don't default.

**Verification is stateless.** The server does *not* check the database on every HTTP
request. There is a `TokenCache` (`auth/token-cache.ts`) that remembers verified tokens
until their own `exp`, FIFO-evicted at 10,000 entries, one cache per app instance.

Consequence you must understand: **revoking a device session does not instantly kill its
HTTP requests.** They keep working for up to 15 minutes (until the access token expires
and refresh fails). Revocation *is* instant on WebSockets — see Flow G/H.

### 6.2 Refresh token — `packages/server/src/auth/refresh.ts` + `app/routes/refresh.ts`

- Value: `randomBytes(32).toString("base64url")`. Opaque. Not a JWT — you cannot decode
  anything from it.
- Server stores only `sha256(token)`.
- Lifetime: **60 days, absolute** (`REFRESH_TTL_MS`). Not extended by use. So even a
  daily-active daemon must re-run `falcon auth login` every 60 days.
- **Rotating**: every refresh gives you a *new* refresh token and retires the old one.

`POST /v1/auth/refresh` has exactly three outcomes:

```
presented = sha256(submitted token)

┌─ Case 1: presented == refresh_token_hash (current), not revoked, not expired
│   → atomic UPDATE: new hash, previous_hash = presented, previous_rotated_at = now
│   → 200 { accessToken, refreshToken: <new> }
│
├─ Case 2: presented == previous_refresh_token_hash
│   ├─ within 60s grace AND not revoked
│   │    → benign race (two browser tabs refreshed at once)
│   │    → 200 { accessToken, refreshToken: <the SAME token you sent back> }
│   │      (the server cannot return the current raw token — it only has the hash —
│   │       so the client contract is "keep what you have when it echoes back")
│   └─ outside grace
│        → THEFT. Revoke every row with this family_id. → 401
│
└─ Case 3: hash unknown (garbage, or ≥ 2 rotations old)
     → 401
```

The happy path is a **single atomic conditional UPDATE**. The `WHERE` clause doubles as
the validity check — a revoked or expired session simply matches zero rows. No
read-then-write race.

This route needs **no** authentication (you have no valid access token when you call it).
Rate limit: 60/minute.

---

## 7. All server endpoints

| Method + path | Auth? | Rate limit | What it does | File |
|---|---|---|---|---|
| `POST /v1/auth/password/register` | no | 10/min | sign up with email+password | `routes/password.ts:80` |
| `POST /v1/auth/password/login` | no | 10/min | sign in | `routes/password.ts:138` |
| `POST /v1/auth/password/reset/request` | no | 10/min | send reset email | `routes/password.ts:204` |
| `POST /v1/auth/password/reset/confirm` | no | 10/min | set new password, revoke all sessions | `routes/password.ts:241` |
| `POST /v1/auth/register` | no | 20/min | OAuth sign-in/sign-up (find-or-create) | `routes/oauth.ts:105` |
| `POST /v1/auth/oauth/github/exchange` | no | 10/min | swap GitHub `code` → access token (needs the client secret) | `routes/oauth.ts:78` |
| `POST /v1/auth/refresh` | no | 60/min | rotate refresh token, mint access token | `routes/refresh.ts:23` |
| `POST /v1/auth/keys/challenge` | **yes** | 20/min | get a single-use nonce | `routes/keys.ts:115` |
| `POST /v1/auth/keys/bind` | **yes** | 20/min | bind or rotate key material | `routes/keys.ts:133` |
| `POST /v1/auth/pair` | no | 60/min | create pairing request **and** pick up the sealed box (single use) | `api/pair.ts:45` |
| `GET  /v1/auth/pair/status` | no | 60/min | cheap poll, never returns secrets | `api/pair.ts:118` |
| `POST /v1/auth/pair/mint` | **yes** | 20/min | mint the new device's session, return refresh token to the approver | `api/pair.ts:154` |
| `POST /v1/auth/pair/approve` | **yes** | 20/min | store the sealed box (first approval wins) | `api/pair.ts:192` |
| `GET  /v1/auth/sessions` | **yes** | none | list my devices + my email | `routes/sessionsAdmin.ts:36` |
| `POST /v1/auth/sessions/:id/revoke` | **yes** | 20/min | kill one device, disconnect its socket now | `routes/sessionsAdmin.ts:82` |
| `POST /v1/auth/sessions/revoke-others` | **yes** | 20/min | kill all other devices | `routes/sessionsAdmin.ts:113` |
| `WS /v1/stream` | **yes** (handshake) | — | Socket.IO, auth in `io.use` middleware | `app/socket.ts:58` |

**Important production note:** all four `/v1/auth/password/*` routes return **404** when
`NODE_ENV=production` (`routes/password.ts:71`). Email+password is a dev/local-testing
identity only. The 404 check runs as a `preValidation` hook — *before* body-schema
validation — so even a malformed request gets 404, not a 400 that would leak "this route
exists and wants these fields".

How `app.authenticate` works (`auth/plugin.ts`): read `Authorization: Bearer <token>` →
check the `TokenCache` → else `verifyToken` → set `request.accountId`, `request.sessionId`,
`request.clientKind`. Registered with `fastify-plugin` so it attaches to the root instance.

---

## Flow A — Sign up with email + password

Entry: `http://localhost:3000/password/` → mode "signup".

```
Browser                                 Server
   │
   │ 1. user types email + password + PIN
   │
   ├─ POST /v1/auth/password/register ────►
   │                                       • normalize email (trim + lowercase)
   │                                       • if identity exists:
   │                                           send "you already have an account" EMAIL
   │                                           return { success:true, token:"", refreshToken:"" }
   │                                           ← identical shape to real signup (no enumeration)
   │                                       • else, in ONE transaction:
   │                                           insert accounts {}          (key_epoch = 0)
   │                                           insert auth_identities {password, argon2id hash}
   │                                       • issueSession(clientKind: "web")
   │  ◄──── { token, refreshToken } ───────
   │
   │ 2. setToken(token)                     ← in-memory variable only
   │
   │ 3. bridge.getIdentity() → null (new browser)
   │    masterSecret = getRandomBytes(32)
   │    bridge.init(masterSecret, pin, refreshToken)
   │        └─ inside the crypto Worker:
   │             wrapped            = wrapWithPin(masterSecret, pin)
   │             wrappedRefreshToken= wrapWithPin(refreshToken, pin)
   │             keyTree            = deriveKeyTree(masterSecret)
   │             IndexedDB.save({ wrapped, signPubKey, contentPubKey, wrappedRefreshToken })
   │
   │ 4. accountId = jwt.sub of the access token
   ├─ POST /v1/auth/keys/challenge ───────► insert key_bind_nonces (TTL 120s)
   │  ◄──── { nonce } ─────────────────────
   │
   │ 5. proof = worker.sign(accountId ‖ contentPubKey ‖ nonce)
   ├─ POST /v1/auth/keys/bind ────────────► verify signature, consume nonce
   │                                        key_epoch: 0 → 1
   │  ◄──── { success, keyEpoch: 1 } ──────
   │
   └─ redirect to /dashboard/  (or /pair/#<ephPub> if a pairing was pending)
```

Code: `web/src/lib/complete-password-sign-in.ts:80` (`completePasswordSignUp`),
`web/src/app/(public)/password/page.tsx`.

**Notice the ordering.** The session is minted *first*, keys are bound *second*. That is
the whole point of the identity/custody split. `keys/bind` requires `app.authenticate` —
key binding always happens as an already-logged-in account.

**No-enumeration detail (`routes/password.ts:98`).** If the email already exists, the
server does *not* return 409. It sends an out-of-band email and returns
`{success:true, token:"", refreshToken:""}`. The web client detects the empty strings and
returns `{kind:"existing-account"}`, then shows *"Check your inbox for next steps, or sign
in below"*. An attacker cannot learn which emails are registered from the response.

---

## Flow B — Sign in with email + password (returning user)

```
Browser                                 Server
   ├─ POST /v1/auth/password/login ──────►
   │                                       identity = find(kind:password, identifier)
   │                                       if !identity            → 401 generic
   │                                       if locked_until > now   → 401 generic  (same text!)
   │                                       if !verifyPassword      → count++, maybe lock
   │                                                               → 401 generic  (same text!)
   │                                       on success: reset failed_login_count = 0, locked_until = null
   │                                       issueSession("web")
   │  ◄──── { token, refreshToken } ───────
   │
   │ setToken(token)   — refreshToken kept only in React state, NOT persisted yet
   │
   │ afterLogin():
   │   ├─ worker already unlocked?  → bridge.setRefreshToken(rt) → /dashboard/
   │   ├─ getIdentity() != null     → show PIN unlock form
   │   │                               on success: setRefreshToken(rt) → /dashboard/
   │   └─ getIdentity() == null     → no keys on this browser → offer "rotate"
```

### Lockout maths (`routes/password.ts:28`)

Rate limiting per IP is not enough — an attacker rotating IPs beats it. So there is a
counter **on the identity row**:

| Consecutive failures | Lock duration |
|---|---|
| 1–4 | none |
| 5 | 30 s |
| 6 | 60 s |
| 7 | 120 s |
| 8 | 240 s |
| … | doubling |
| 11+ | capped at 15 min |

Formula: `min(15min, 30s × 2^(count − 5))`.

A correct password clears both the counter and the lock. A real user who mistypes twice
notices nothing.

**All three failure modes return the exact same 401 body**: `"Invalid email or password"`.
No oracle for "does this email exist" or "am I currently locked".

---

## Flow C — Sign in with Google / GitHub

Two different OAuth flows, because the web app is a **static export with no server of its
own** (`web/src/lib/oauth.ts`).

### Google — OIDC implicit flow

```
/signin/ → beginGoogleSignIn()
   state = random hex → sessionStorage["falcon:oauth:state"]
   redirect to accounts.google.com/o/oauth2/v2/auth
       response_type=id_token   scope=openid   nonce=random   state=state
   ↓
Google → /auth/callback/google/#id_token=…&state=…
   the ID token comes back in the URL FRAGMENT → never sent to any server
   consumeGoogleCallback(hash): check state matches, take id_token
   ↓
POST /v1/auth/register { oauthProvider:"google", oauthProof:<id_token> }
   server: jwtVerify against Google's live JWKS
           issuer must be accounts.google.com
           audience must be GOOGLE_OAUTH_CLIENT_ID   ← if unset, reject everything
```

Fail-closed detail (`server/src/auth/oauth.ts:63`): if `GOOGLE_OAUTH_CLIENT_ID` is not
configured, `verifyGoogleIdToken` returns `null` immediately. Skipping the audience check
would accept *any* Google-issued token from *any* app as proof of your identity.

### GitHub — authorization-code flow (needs a proxy)

```
/signin/ → beginGithubSignIn()   scope = "read:user user:email"
   ↓
GitHub → /auth/callback/github/?code=…&state=…
   ↓
POST /v1/auth/oauth/github/exchange { code, redirectUri }
   ← the server does this because GitHub's token endpoint needs the client SECRET
     and has no browser CORS allowance
   → { accessToken }
   ↓
POST /v1/auth/register { oauthProvider:"github", oauthProof:<accessToken> }
   server: GET api.github.com/user      ← opaque token, so live confirmation IS the proof
           GET api.github.com/user/emails ← best-effort, failure does NOT fail sign-in
```

### After `register` returns (both providers)

`/v1/auth/register` is **find-or-create by `(kind, subject)`**. Signing in twice with the
same Google account always lands on the same account row. It does **not** touch key
material at all.

`web/src/components/auth/oauth-callback-page.tsx` then branches:

| This browser has… | What happens |
|---|---|
| no identity in IndexedDB | show `PinSetupForm` → `completeOAuthSignIn(..., pin)` → generate masterSecret, `init`, `keys/bind` |
| an identity, worker unlocked | `setRefreshToken(rt)` → redirect |
| an identity, worker locked | show `PinUnlockForm` → unlock → `setRefreshToken(rt)` → redirect |
| a pending step-up flag | complete sign-in, then hand `{provider, oauthProof, refreshToken}` **in memory** to `/reset-keys/` |
| `keys/bind` returns **409** | account already has keys elsewhere → show "Pair from another device" / "Reset keys" |

**Confused-deputy defence** (`oauth-callback-page.tsx:76`): the pending step-up flag is
consumed **once** and must match the provider. An abandoned Google step-up cannot hijack
a later GitHub sign-in in the same tab.

Email backfill (`routes/oauth.ts:157`): a returning identity with no stored email gets one
filled in on next login. It **never overwrites** an existing email.

---

## Flow D — Binding keys to the account (`keys/bind`)

This is where identity and custody finally meet. File: `server/src/app/routes/keys.ts`.

### Step 1 — challenge

```
POST /v1/auth/keys/challenge   (authenticated)
→ nonce = randomBytes(32).toString("base64")
  insert key_bind_nonces { accountId, nonce, expiresAt = now + 120s }
→ { nonce }
```

The nonce is **server-chosen**, not client-chosen. The old `/v1/auth` route let the
client pick its own challenge, which is replayable. See the schema comment at
`db/schema.ts:101`.

### Step 2 — bind

Client signs, inside the worker (`web/src/crypto/worker-handler.ts:261`):

```
message   = utf8(accountId) ‖ contentPubKey(32 bytes) ‖ nonce(32 bytes)
signature = ed25519_sign(message, keyTree.signing.secretKey)
```

Server checks, in this exact order:

```
1. consumeNonce()          atomic UPDATE … WHERE nonce=? AND accountId=? AND consumedAt IS NULL AND expiresAt > now
                           → 0 rows ⇒ 401 "Invalid or expired nonce"
2. signPubKey length == 32 ⇒ else 401
3. ed25519 verify          ⇒ else 401
4. account exists          ⇒ else 401
5. is this a rotation?
     isFirstBind = (key_epoch == 0)
     sameKey     = (stored sign_public_key == this one)
     if !isFirstBind && !sameKey:
         a. body.rotate must be true            ⇒ else 409 "rotation must be explicit"
         b. verifyStepUp(...)                   ⇒ else 401 "Step-up required"
         c. no OTHER healthy device sessions    ⇒ else 409 "Other devices are online"
6. this signPubKey not already on another account ⇒ else 409
7. TRANSACTION:
     accounts.set(signPublicKey, contentPubKey, key_epoch = 1 | same | +1)
     if rotating: revoke EVERY OTHER device_session   ← the fence
```

### What is "step-up"? (`routes/keys.ts:82`)

Re-proving ownership through whatever identity the account actually has:

- **password account** → re-enter the password, verified against the stored argon2id hash.
- **oauth account** → do a fresh OAuth round trip. The resulting identity **must match a
  row on this same account**. A perfectly valid Google proof for a *different* account
  does not step this one up.

### Why the "other devices are online" interlock? (`routes/keys.ts:46`)

If you rotate keys while your CLI daemon is still happily running, that daemon still holds
the **old** masterSecret and will keep writing data encrypted under the dead epoch. The
result is split-brain: rows nobody can read. So the server refuses the rotation and tells
you to pair instead.

"Healthy" = not revoked AND not expired AND not the current session.

### `keyEpoch` transitions

| Situation | Old epoch | New epoch |
|---|---|---|
| first bind ever | 0 | 1 |
| rebinding the same key (idempotent) | N | N |
| rotation | N | N+1 |

Every encrypted row records the epoch its DEK was wrapped under
(`sessions.key_epoch`, `machines.key_epoch`, `workspaces.key_epoch`). After a rotation,
rows at the old epoch become unreadable — that is the "archived" data the UI warns about.

---

## Flow E — Pairing the CLI (`falcon auth login`)

This is the most interesting flow. The goal: give a brand-new device the masterSecret
**without** the server ever seeing it, and without the user copying a secret by hand.

```
CLI                          Server                        Browser (already signed in)
 │
 │ 1. keypair = tweetnacl.box.keyPair()     ← ephemeral X25519, NEVER written to disk
 │    ephPub  = base64(keypair.publicKey)
 │
 ├─ POST /v1/auth/pair {ephPub} ──►
 │                          INSERT pair_requests {ephPub, expiresAt = now+15min}
 │                          ON CONFLICT DO NOTHING
 │  ◄── { state: "pending" }
 │
 │ 2. print URL + QR:
 │    app.falcon.dev/pair#<base64url(ephPub)>
 │    and try to open the browser (best effort)
 │                                                          3. user opens the link
 │                                                             ├─ hash → bytes → re-encode
 │                                                             │   to PLAIN base64  ⚠ see note
 │                                                             ├─ worker locked? → PIN prompt
 │                                                             ├─ signed out? → stash ephPub,
 │                                                             │    /signin/, come back
 │                                                             └─ show "Approve / Cancel"
 │
 │ 3. poll GET /v1/auth/pair/status?ephPub=…  every 2s
 │    (this endpoint NEVER returns secret material)
 │                                                          4. user clicks Approve
 │                          ◄── POST /v1/auth/pair/mint {ephPub} ──┤
 │                          issueSession(clientKind:"cli-daemon")
 │                          ── { refreshToken } ──────────────────►│
 │                            ⚠ handed straight to the BROWSER,
 │                              never stored in pair_requests
 │                                                             5. sealed = worker.sealForPeer(
 │                                                                    ephPub, refreshToken)
 │                                                                payload = [0x01
 │                                                                          | masterSecret(32)
 │                                                                          | refreshToken(rest)]
 │                                                                sealed  = libsodium sealed_box(
 │                                                                          ephPub, payload)
 │                          ◄── POST /v1/auth/pair/approve {ephPub, response: sealed} ──┤
 │                          UPDATE pair_requests SET response=…, state='authorized'
 │                          WHERE ephPub=? AND response IS NULL   ← first-approval-wins, atomic
 │
 │ 6. status says "authorized"
 ├─ POST /v1/auth/pair {ephPub} ──►
 │                          DELETE FROM pair_requests
 │                          WHERE ephPub=? AND response IS NOT NULL
 │                          RETURNING *                       ← SINGLE-USE PICKUP
 │  ◄── { state:"authorized", response: <sealed box> }
 │
 │ 7. payload = libsodiumDecryptWithSecretKey(sealed, keypair.secretKey)
 │    check payload[0] == 0x01 and length > 33
 │    masterSecret = payload[1..33]
 │    refreshToken = utf8(payload[33..])
 │
 │ 8. keyMaterial = wrapWithDeviceKey(masterSecret, ~/.falcon)   ← OS Keychain
 │    write ~/.falcon/access.key  { refreshToken, keyMaterial }  chmod 0600
 │
 └─ "Logged in to Falcon."
```

### Why each piece exists

| Design choice | Why | Where |
|---|---|---|
| ephemeral keypair, never persisted | if the CLI dies mid-pairing, the next attempt just makes a new one; nothing to steal from disk | `cli/src/auth/pair.ts:143` |
| hard 15-minute TTL | an unbounded pairing window was a reported vulnerability in the reference project (Happy) | `api/pair.ts:17` |
| `/pair/status` never returns the box | so the cheap unauthenticated poll cannot be used to fish for secrets | `api/pair.ts:117` |
| pickup is a `DELETE … RETURNING` | single-use. A second poll finds no row, re-inserts a fresh `pending` — it never re-serves the same secret. | `api/pair.ts:87` |
| `/pair/mint` gives the refresh token to the **browser** | so the worker can seal it together with the masterSecret. It never travels in plaintext through the DB. | `api/pair.ts:154` |
| approve is one atomic conditional UPDATE | first-approval-wins without a TOCTOU race (the reference implementation used read-then-write) | `api/pair.ts:232` |
| CLI wraps with **device key**, not PIN | the daemon runs unattended — nobody is there to type a PIN | `cli/src/auth/keyMaterial.ts:21` |

### ⚠ The base64 vs base64url trap

The CLI puts the ephemeral key in the URL fragment as **base64url**
(`encodeBase64Url`, URL-safe, no padding). But it registered the request with the server
using **plain base64**. The server looks the row up by *string* comparison
(`eq(pairRequests.ephPub, …)`), not by bytes.

So the browser must decode the fragment as base64url and **re-encode as plain base64**
before every downstream call. `web/src/app/(public)/pair/page.tsx:55` does this, and
`worker-handler.ts:291` has a long comment about a real bug this caused: keys that happen
to contain `+` or `/` were silently mangled.

### CLI failure messages (`cli/src/auth/login.ts:50`)

| Reason | Message |
|---|---|
| `request-failed` | "Could not reach the Falcon server. Check FALCON_BACKEND_URL…" |
| `expired` | "Pairing request expired before it was approved. Run `falcon auth login` again." |
| `cancelled` | "Sign-in cancelled." (Ctrl-C) |
| `decrypt-failed` | "Received an unreadable response from the server." |

Also: `ensureLoggedIn()` (`login.ts:33`) means a first-time `falcon claude` on a real TTY
runs the whole pairing flow inline instead of failing with "run auth login first". Without
a TTY (CI), it keeps the honest hard failure.

---

## Flow F — Page reload: PIN unlock + silent refresh

This is the flow you will test most often. It looks like magic, so understand the order.

### What survives a browser reload?

| Thing | Survives reload? | Why |
|---|---|---|
| access token | ❌ no | plain module variable in `lib/session.ts:25` |
| refresh token | ✅ yes, but **PIN-wrapped** in IndexedDB | `wrappedRefreshToken` |
| masterSecret | ✅ yes, but **PIN-wrapped** in IndexedDB | `wrapped` |
| unlocked worker memory | ❌ no | new JS realm, new Worker |
| `signPubKey` / `contentPubKey` | ✅ yes, **in the clear** | so `getIdentity()` can answer "known device?" without a PIN |

So after a reload you have **nothing usable** until the PIN is typed. That is by design.

### The gate order (`web/src/features/auth/require-auth.tsx`)

```
RequireAuth
   │
   ├─ useUnlockedCryptoBridge()
   │     status = "loading"      → render nothing
   │     status = "no-identity"  → "This browser has no Falcon key material" + Reset keys button
   │     status = "needs-unlock" → <PinUnlockForm> (+ "Forgot your PIN?" → /reset-keys/)
   │     status = "ready"        → continue ↓
   │
   ├─ ensureSession()
   │     isSignedIn()?  (access token exists and exp not passed)
   │       yes → sessionReady = true
   │       no  → silentRefresh()
   │               bridge = getSharedCryptoBridge()   ← null unless unlocked
   │               accessToken = await bridge.refreshSession()
   │                   ↳ this HTTP call happens INSIDE the worker
   │               ok  → setToken(accessToken), sessionReady = true
   │               bad → router.replace("/signin/?reason=expired")
   │
   ├─ setInterval(ensureSession, 60_000)   ← keeps checking while mounted
   │
   └─ sessionReady ? children : null
```

**The unlock gate is first, not second.** Reason: the refresh token only exists
PIN-wrapped inside the worker. There is literally nothing to refresh *from* until the
worker is unlocked. The docblock at `require-auth.tsx:57` states this.

### `refreshSession()` inside the worker (`worker-handler.ts:325`)

```
if (!refreshToken)                   → return null        (normal "not signed in")
fetch POST ${API_URL}/v1/auth/refresh { refreshToken }
   !res.ok                           → return null
   body not {accessToken,refreshToken} → return null
   refreshToken = body.refreshToken            ← rotate in memory
   persistRefreshToken()                       ← re-wrap under the cached PIN, save
   return body.accessToken                     ← ONLY this crosses back to the main thread
```

The raw refresh token **never** leaves the worker. There is no `getRefreshToken()` method
on `CryptoBridgeClient` and there must never be one.

### The shared-worker refcount trick (`lib/use-crypto-bridge.ts`)

Many components call `useCryptoBridge()`. If each got its own Worker, each would be locked
and each would need its own PIN. So there is one shared instance, refcounted.

Teardown is **debounced by 2000 ms** (`RELEASE_GRACE_MS`). Why: a client-side route change
unmounts the old page and mounts the new one as two separate React commits, so the refcount
briefly hits 0 even though it is the same page load. Tearing down there would re-lock the
worker for the very next page.

A **full reload** always wipes this module state (new JS realm) — which is exactly the
"reload requires PIN" behaviour that is wanted.

### The `?reason=expired` banner

A failed silent refresh redirects to `/signin/?reason=expired`, and the sign-in page shows
*"Your session expired — sign in again to continue."*
A **deliberate** logout redirects to plain `/signin/` — no banner, because that is not a
surprise. (`require-auth.tsx:24`, `signin/signin-gate.ts`.)

---

## Flow G — WebSocket authentication and in-band renew

File: `packages/server/src/app/socket.ts`.

### At connect (`io.use` middleware, line 58)

Auth runs in **middleware**, not in the `connection` callback. Reason (line 54): an async
verify inside the callback creates a window where client events (`rpc-register`,
`rpc-call`) arrive before handlers are attached and get silently dropped.

```
handshake.auth = { token, clientType, sessionId?, machineId?, appState? }

1. token missing                                → reject "Missing authentication token"
2. clientType "session-scoped" without sessionId → reject
3. clientType "machine-scoped" without machineId → reject
4. verifyToken(token) fails                      → reject "Invalid authentication token"
5. ▶ THE ONE DB HIT ◀
   row = device_sessions where id = jwt.sid
   if !row || row.revokedAt || row.expiresAt < now → reject "Session revoked"
6. store on socket.data:
      accountId, clientType, sessionId, machineId
      authSessionId = jwt.sid     ← different field from sessionId! see below
      tokenExpiresAt = jwt.exp
      appState = handshake appState ?? "background"
```

⚠ **`sessionId` vs `authSessionId`.** These are two different things and mixing them up
will confuse you:

| Field | Means |
|---|---|
| `socket.data.sessionId` | the **provider/coding session** this socket watches (unrelated to auth) |
| `socket.data.authSessionId` | the **device_sessions.id** from the JWT — this is what revoke matches on |

### While connected — the expiry timer (line 172)

```
armExpiryTimer(exp):
    clearTimeout(old)
    setTimeout(() => socket.disconnect(true), exp*1000 − now)
```

If the server just hard-disconnected everyone at token expiry, every client would flap its
connection every 15 minutes. So instead:

```
client                                    server
   │   (10 min after connect)
   ├─ tokenProvider/silentRefresh → fresh access token
   ├─ emit("renew-token", token, ack) ──►
   │                                    verifyToken(token)
   │                                    accountId must still match
   │                                    device_sessions row must exist and not be revoked
   │                                    → socket.data.authSessionId / tokenExpiresAt updated
   │                                    → armExpiryTimer(new exp)
   │  ◄─── ack(true) ─────────────────
   └─ arm the next renew timer
```

If the ack is `false`, the server disconnects immediately.

Renew intervals (all fixed, all comfortably inside the 15-minute TTL):

| Client | Interval | File |
|---|---|---|
| web | 10 min | `web/src/sync/apiSocket.ts:160` |
| CLI daemon (machine socket) | 10 min | `cli/src/daemon/machineClient.ts:415` |
| CLI session socket | `deps.renewIntervalMs` | `cli/src/session/sessionClient.ts:163` |

### On `connect_error`

All three clients test the error message against `/authentication token|Session revoked/i`
and then try **one** silent refresh, so socket.io's own automatic retry presents a fresh
token on the next attempt. If the refresh token is dead, the retry loop keeps failing but
logs a clear "run `falcon auth login`" line instead of retrying silently forever.

There is a real bug story in `apiSocket.ts:249`: the regex used to match only the first two
messages, so a tab revoked from another device kept retrying a doomed handshake forever. It
was widened to include `Session revoked`.

### Machine presence and "needs re-auth" (AH8)

When a machine-scoped socket disconnects, the server broadcasts an offline ephemeral. It
also asks `computeMachineNeedsReauth()` (`app/machineReauth.ts`): *is the most recent
`cli-daemon` device session for this machine revoked?* If yes, `needsReauth: true` rides
along so the web UI can say "this machine needs `falcon auth login` again".

A daemon whose refresh token was revoked cannot tell you anything over its now-dead socket.
So the server infers it. `needsReauth` is **omitted** (not `false`) in the normal case, so
the payload stays byte-identical to the pre-AH8 shape.

---

## Flow H — Logout and device revocation

### Three different "logouts"

| Action | What dies | Where |
|---|---|---|
| **CLI `falcon auth logout`** | just deletes `~/.falcon/access.key` locally. The server-side device session stays alive until it expires. | `cli/src/auth/logout.ts` |
| **Web sign-out button** | local teardown only (see below) | `web/src/lib/logout.ts` |
| **Settings → Devices → Log out** | server-side revoke + immediate socket disconnect | `routes/sessionsAdmin.ts` |

### Web local teardown — order matters (`lib/logout.ts`)

```
1. wipe key material    — spin up a THROWAWAY crypto bridge, call clear()
                          → IndexedDB record deleted, worker memory reset
                          → markCryptoBridgeLocked()
                          (a throwaway worker, so it works whether or not anything is mounted)
2. disconnect apiSocket — stop the infinite reconnect loop BEFORE the token disappears,
                          so it never fires a reconnect with null auth
3. clearToken()         — last, so nothing above sees a signed-out state while still running
```

A key-wipe failure is logged but never aborts steps 2 and 3.

### Server-side revoke

```
POST /v1/auth/sessions/:id/revoke
   UPDATE device_sessions SET revoked_at = now
   WHERE id = :id AND account_id = <me>     ← you can only revoke your own
   0 rows → 404
   then: disconnectSession(router, accountId, id)
         → for each live socket of this account: if socket.data.authSessionId === id → disconnect(true)
```

`POST /v1/auth/sessions/revoke-others` does the same for every row except the current one,
and disconnects each.

### ⚠ Revocation is instant on sockets, delayed on HTTP

| Channel | Delay |
|---|---|
| WebSocket | **immediate** — `disconnectSession` kills it now, and reconnects fail the step-5 DB check |
| HTTP | **up to 15 minutes** — access tokens are stateless and cached in `TokenCache` |
| Refresh | **immediate** — the atomic rotate `WHERE` clause requires `revokedAt IS NULL` |

So a revoked device can still make HTTP calls with its already-minted access token until it
expires. This is a deliberate accepted trade for stateless verification. If you need
absolute-instant HTTP revocation, you would need a DB check per request.

Revoking your **own current** session (`isCurrent`) also runs the full local logout and
redirects to `/signin/` — `DevicesSection.tsx:107`.

The Devices UI requires **two clicks** (click → "Confirm") for every revoke, because a
misclick is destructive.

---

## Flow I — Forgot PIN → reset keys (rotate epoch)

Entry points into `/reset-keys/`:
- `RequireAuth`'s `no-identity` dead end
- `PinUnlockForm`'s "Forgot your PIN?" link
- the OAuth callback's `already-bound` 409 branch

```
/reset-keys/  phase = "confirm-identity"
   │
   ├─ [Pair from another device]  ← THE SAFE OPTION, shown first and prominently
   │     keeps all your encrypted sessions
   │
   └─ [Reset keys instead] → confirm → [Confirm with Google] / [Confirm with GitHub]
         │
         │  stashPendingStepUp({provider})  → beginGoogleSignIn()/beginGithubSignIn()
         ▼
      provider → /auth/callback/<provider>/
         consumePendingStepUp(provider) matches → this is a step-up, not a plain sign-in
         POST /v1/auth/register with the proof → fresh { token, refreshToken }
         setToken(token)
         setStepUpReturn({provider, oauthProof, refreshToken})   ← IN MEMORY ONLY
         router.replace("/reset-keys/")
         ▼
      /reset-keys/  phase = "returned"  → <PinSetupForm>
         │
         └─ rotateKeyEpochOAuth(bridge, accessToken, refreshToken, newPin, {provider, oauthProof})
               masterSecret = getRandomBytes(32)             ← BRAND NEW
               bridge.init(masterSecret, newPin, refreshToken)  ← overwrites IndexedDB now
               keysChallenge → nonce
               bindKeysProof(accountId, nonce)
               keysBind({ …, rotate: true, stepUpProof: {kind:"oauth", provider, oauthProof} })
                  server: step-up ok? other devices offline? → epoch N+1, revoke all others
               → /dashboard/
```

Outcome mapping (`complete-password-sign-in.ts:238`):

| Server response | UI |
|---|---|
| 200 | redirect to `/dashboard/` |
| 401 | "That account doesn't match this one." → back to confirm-identity |
| 409 | "Another device is still signed in — pair this browser from that device instead of rotating keys blind." |
| other | generic error + Try again |

There is a password twin, `rotateKeyEpoch()`, using `stepUpProof: {kind:"password"}`. It is
only reachable in dev, since `/password/` routes 404 in production.

### ⚠ Known ordering wart (documented in the code)

`bridge.init` **must** run before `bridge.bindKeysProof` — the worker refuses to sign when
it is not initialised. That means if the server later rejects the bind (401 or 409), this
browser has **already overwritten** its previous wrapped record. Only abandoning the flow
before submitting avoids orphaning the old key material. The docblock at
`complete-password-sign-in.ts:229` says this openly.

---

## Flow J — Password reset

```
POST /v1/auth/password/reset/request { email }
   identity found?
      yes → token = randomBytes(32).base64url
            insert password_reset_tokens { authIdentityId, token, expiresAt = now + 1h }
            email.sendResetEmail(...)
      no  → do nothing
   → ALWAYS 200 { success: true }        ← no enumeration

POST /v1/auth/password/reset/confirm { token, password }
   row = find where token=? AND consumedAt IS NULL AND expiresAt > now
   !row → 401
   TRANSACTION:
      mark token consumed
      update auth_identities.passwordHash
      ▶ UPDATE device_sessions SET revoked_at = now WHERE account_id = <this account> ◀
        (ALL of them — a forgotten password is treated as possible compromise)
   → 200
```

Note the reset token points at an **identity**, not an account. Resetting your password
does not touch your Google or GitHub identity on the same account.

The email transport at MVP is `createDevLoggerEmailTransport` — it logs. The "reset URL"
literally contains the raw token in dev (`routes/password.ts:232`).

---

## Flow K — CLI daily life (daemon + session)

### On disk: `~/.falcon/access.key` (0600)

```json
{
  "refreshToken": "…base64url…",
  "keyMaterial": {
    "mode": "device",
    "wrapped": { "v": 1, "nonce": "…", "ct": "…" }
  }
}
```

Three legal `keyMaterial.mode` values (`cli/src/auth/credentials.ts:51`):

| mode | How it is wrapped | Written today? | Needs a human? |
|---|---|---|---|
| `device` | random AES-256 key stored in the **OS vault** (macOS Keychain / Windows Credential Manager / Linux Secret Service, via `@napi-rs/keyring`) | ✅ **only mode written** | no |
| `pin` | argon2id + AES-256-GCM, same as web | ❌ legacy read-only | **yes** — so the daemon can never use it |
| `plaintext-fallback` | not wrapped at all, base64 | ❌ only for `e2e/` test harness | no |

If the OS vault is unavailable (no Secret Service daemon, locked, …), the device key falls
back to a plaintext `~/.falcon/device.key` file at 0600. This is **documented, not silent**
(`cli/src/auth/deviceKey.ts:16`). The code is honest that this "delivers little at-rest
benefit on daemon boxes anyway" — a compromise that reads `access.key` can usually also
reach the vault. What it does buy: the wrapping key is not inside the file a dotfiles-sync
tool might scoop up.

**No access token is ever stored on disk.** Only the refresh token.

### `TokenProvider` — the daemon's lifeline (`cli/src/auth/tokenProvider.ts`)

This exists because of a real bug: known-issues.md #4, *"daemon silently dies after 1h"*.
The old code handed every network client a fixed `token: string`. When it expired, they
retried the dead credential forever.

```
getAccessToken():
    if cached && now < cachedExpiresAt − 60_000   → return cached
    else refreshOnce()

refreshOnce():   one shared in-flight promise, so concurrent callers do not
                 rotate the token out from under each other

doRefresh():
    POST /v1/auth/refresh { refreshToken }
    401        → dead = true, log "run `falcon auth login`", return null   ← STOP RETRYING
    !ok        → warn, return null                                        (transient)
    bad schema → warn, return null
    ok         → refreshToken = new one
                 cachedAccessToken = accessToken
                 cachedExpiresAtMs = decodeTokenClaimsUnverified(...).exp * 1000
                 onRotate(refreshToken)   ← writes access.key; failure is logged, not fatal
```

`REFRESH_SKEW_MS = 60_000` — refresh one minute before real expiry, so a caller never
observes a token that is valid on paper but rejected mid-request.

Sockets pass `auth` as an **async callback**, not a static object
(`machineClient.ts:369`, `sessionClient.ts:125`), so every reconnect — hours or days later
— asks for a *currently valid* token.

### Daemon boot (`cli/src/daemon/machineIntegration.ts:280`)

```
credentials = readCredentials()          → none? "local-only mode", skip machine client
tokenProvider = createTokenProvider(..., onRotate: write access.key)
masterSecret = resolveKeyMaterial(credentials.keyMaterial, homeDir)
      "pin" mode with no pinDeps → returns null  ← "skip, don't hang". The daemon has no TTY.
if (!masterSecret || length !== 32) → warn and skip the machine client
keyTree = deriveKeyTree(masterSecret)
reuse the previously persisted wrappedDek if there is one   ← or the server desyncs after restart
```

That last line matters: `POST /v1/machines`'s CAS-update path never re-sends or rotates
`dek`. A restarted daemon that minted a *different* local DEK would silently break every
machine RPC decrypt.

### `falcon auth status` (`cli/src/auth/status.ts`)

Makes **no network call** — there is no access token on disk to introspect any more. It
prints: logged in or not, the credentials path, the key-material mode, and (for `device` /
`plaintext-fallback` only) the first 16 hex chars of the derived signing public key as an
account fingerprint.

---

## 19. Where every secret lives

| Secret | Browser | CLI | Server |
|---|---|---|---|
| password | never leaves the form | — | argon2id PHC in `auth_identities.password_hash` |
| **masterSecret** | IndexedDB, argon2id+AES-GCM under PIN. Unwrapped only in Worker memory. | `access.key`, AES-GCM under an OS-vault device key | ❌ **never** |
| **access token** | plain module variable, memory only | `TokenProvider` memory only | not stored — stateless JWT (+ verify cache) |
| **refresh token** | IndexedDB, PIN-wrapped. Raw form exists only inside the Worker. | `access.key`, plaintext field (the file is 0600) | only `sha256(...)` |
| PIN | Worker memory while unlocked (needed to re-wrap on rotation) | — | ❌ never |
| DEKs | Worker memory (`activeDek`) | process memory | wrapped bytes in `dek` columns |
| `FALCON_MASTER_SECRET` | ❌ | ❌ | env var — signs every JWT |
| GitHub client secret | ❌ (static export has no secrets) | ❌ | env var |

### Why the access token is NOT in localStorage (security review F1)

`web/src/lib/session.ts:1` explains the trade honestly:

- The refresh token used to sit in `localStorage`. Fully XSS-readable. One passive read
  gave an attacker a **60-day full-account credential**, which destroyed the whole point of
  the 15-minute access token.
- Now the refresh token is only ever PIN-wrapped in IndexedDB, or unwrapped inside the
  Worker.
- The access token is a plain in-memory variable. An XSS with arbitrary code execution can
  still read that variable (or just hook `fetch`) — that was always true regardless of
  storage. But it no longer persists across reloads for a passive read to find, and it is
  never the long-lived credential.

---

## 20. Attacks and defenses

| Attack | Defense | Code |
|---|---|---|
| Guess passwords by rotating IPs | per-identity lockout counter with exponential backoff | `routes/password.ts:28` |
| Learn which emails are registered | identical 401 for all three failure modes; identical `{success:true}` for a duplicate sign-up; always-200 reset request | `routes/password.ts:99, 149, 222` |
| Steal a refresh token and use it | rotation + previous-hash lineage: replay outside the 60 s grace revokes the **entire family** | `routes/refresh.ts:88` |
| Replay a key-bind signature | server-minted single-use nonce with 120 s TTL, consumed by an atomic UPDATE | `routes/keys.ts:24` |
| Bind your own keys onto someone's account | the signature covers `accountId ‖ contentPubKey ‖ nonce`, and the route requires `app.authenticate` | `routes/keys.ts:163` |
| Silently take over an account by rotating keys | rotation needs `rotate:true` **and** a step-up proof **and** no other live device | `routes/keys.ts:191` |
| Reuse one account's OAuth proof to step up another | verified identity must match a row on **this** account | `routes/keys.ts:98` |
| Steal the pairing secret from the DB | the sealed box is opened only by the ephemeral private key, which only the CLI process has | `api/pair.ts:38` |
| Replay a pairing pickup | `DELETE … RETURNING` — single use | `api/pair.ts:87` |
| Race two pairing approvals | one atomic `UPDATE … WHERE response IS NULL` | `api/pair.ts:232` |
| Leave a pairing window open forever | hard 15-minute TTL checked live on every read | `api/pair.ts:17` |
| Accept a Google token minted for another app | `audience` is checked; unset client id ⇒ reject everything (fail closed) | `auth/oauth.ts:63` |
| Enumerate routes in production | password routes 404 via a `preValidation` hook (before schema validation) | `routes/password.ts:71` |
| Wildcard CORS with credentials | explicit origin allowlist for both HTTP and Socket.IO | `app/security/cors.ts`, `socket.ts:36` |
| Keep using a revoked session's socket | one DB check at handshake + `disconnectSession` on revoke | `socket.ts:95`, `eventRouter.ts:309` |
| XSS reading a 60-day credential | refresh token never in `localStorage`; lives PIN-wrapped or inside the Worker | `lib/session.ts:1` |
| Confused deputy in OAuth step-up | one-shot flag + provider must match | `oauth-callback-page.tsx:76` |
| CSRF/replay on the OAuth redirect | one-time `state` in `sessionStorage`, cleared on first use; Google `nonce` too | `lib/oauth.ts:24` |
| Read `access.key` off a shared box | 0600 + the wrapping key lives in the OS vault | `cli/src/auth/credentials.ts:70`, `deviceKey.ts` |

---

## 21. What breaks, and what the user sees

| Situation | What actually happens | What the user sees |
|---|---|---|
| Wrong PIN in the browser | `unwrapWithPin` returns `null` (auth tag mismatch) — never throws | "Wrong PIN. Try again." Unlimited retries. |
| Wrong PIN in the CLI (legacy `pin` mode) | 3 attempts then give up | "Wrong PIN — try again." ×2, then fail |
| Browser reload | Worker is a new instance, memory empty | PIN prompt. **This is expected — test it.** |
| Access token expires while you sit on the page | `RequireAuth`'s 60 s interval calls `silentRefresh()` | nothing at all |
| Access token expires on a live socket | 10-minute `renew-token` timer beats the 15-minute TTL | nothing at all |
| Refresh token expires (60 days) | refresh 401 → `dead = true` | web: `/signin/?reason=expired`. CLI: "run `falcon auth login`" |
| Refresh token replayed after theft | whole `family_id` revoked | both the thief and the real user are logged out |
| Another device revokes you | socket drops now; HTTP works ≤ 15 min more; next refresh 401 | "Your session expired" |
| PIN forgotten | nothing can unwrap IndexedDB | "Forgot your PIN?" → `/reset-keys/`. **Old encrypted sessions are lost.** |
| Keys rotated while the daemon is running | `keys/bind` returns 409 first | "Another device is still signed in — pair this browser instead" |
| Daemon's session revoked | socket dies, refresh 401 | machine shows offline **with `needsReauth`** in the web UI |
| Browser has an identity but the account has other keys | `keys/bind` 409 without `rotate` | "Pair from another device" / "Reset keys for this browser" |
| OS vault unavailable on Linux | falls back to `~/.falcon/device.key` 0600 | nothing — but it is documented, not silent |
| Two tabs refresh at the same instant | previous-hash + 60 s grace | nothing — both keep working |
| Server restarts | `TokenCache` empties | nothing — one extra verify per token |

---

## 22. Sharp edges and gotchas

Things that will bite you when you read or change this code.

1. **`sessionId` is overloaded.** `device_sessions.id` (auth) vs a coding session id
   (product). On a socket they are `socket.data.authSessionId` and `socket.data.sessionId`.
   Never mix them.

2. **base64 vs base64url in pairing.** The CLI URL fragment is base64url; the server's
   lookup key is plain base64. The browser must convert. See Flow E.

3. **`open()` in `@falcon/crypto` does not validate `t`/`v`.** It only reads `box.c`.
   Callers must validate with `@falcon/wire`'s `EncryptedBoxSchema` first
   (`crypto/src/box.ts:25`).

4. **Nothing in `@falcon/crypto` throws.** Wrong PIN, corrupt bytes, wrong key → `null`.
   Branch on the return value; do not write `try/catch`.

5. **`verifyToken` also never throws.** Same rule.

6. **Refresh in the "benign race" branch echoes your own token back.** The server only has
   hashes, so it cannot give you the current raw token. Client contract: if the response's
   `refreshToken` equals what you sent, keep it.

7. **`renew-token` checks `revokedAt` but not `expiresAt`.** Connect checks both
   (`socket.ts:98`); renew checks only revocation (`socket.ts:188`). In practice the access
   token's own `exp` bounds it, but note the asymmetry.

8. **HTTP revocation is not instant.** Up to 15 minutes. Accepted trade for stateless auth.

9. **`cli-session` and `cloud-sandbox` are declared but never minted.** `falcon claude`
   reuses the daemon's refresh token from `access.key`.

10. **`falcon auth logout` is local only.** It does not revoke the server-side session. Use
    Settings → Devices for that.

11. **`bridge.init` before `bindKeysProof` in the rotate flow** means a rejected rotation
    has already overwritten this browser's key record. Documented, not fixed.

12. **The 2-second `RELEASE_GRACE_MS`** is what keeps you unlocked across client-side
    navigation. Remove it and every route change re-prompts for the PIN.

13. **`keys/bind` rebinding the *same* key is idempotent** — epoch does not move, no
    step-up, no fence. Only a *different* key counts as a rotation.

14. **Email is never an auth gate.** Authorization is `(kind, subject)` alone.
    `email`/`emailVerified` are display metadata. `GET /v1/auth/sessions` returns unverified
    emails the same as verified ones on purpose.

15. **Password routes 404 in production**, so any production recovery flow must go through
    `/reset-keys/` with an OAuth step-up.

---

## 23. File map

### `packages/crypto` — platform-neutral primitives
| File | What |
|---|---|
| `keys.ts` | `deriveKeyTree`, `deriveBlobKey`, `signDetached`, `verifyDetached` |
| `pin.ts` / `pin.web.ts` | `wrapWithPin` / `unwrapWithPin`. Node uses `@node-rs/argon2`, browser uses libsodium-sumo. Byte-portable. |
| `pin-params.ts` | the shared numbers: salt 16 B, nonce 12 B, key 32 B, argon2id **64 MiB / t=3 / p=1** |
| `dek.ts` | `wrapDek` / `unwrapDek` (sealed box, version byte `0x00`) |
| `box.ts` | `seal` / `open` (`EncryptedBox`) |
| `encryption.ts` / `.web.ts` | the AES-GCM + libsodium primitives underneath |

### `packages/server`
| File | What |
|---|---|
| `auth/tokens.ts` | mint + verify JWT (HS256, 15 min, `sub`/`sid`/`ct`) |
| `auth/refresh.ts` | `issueSession`, `newRefreshToken`, `hashRefreshToken`, `REFRESH_TTL_MS` |
| `auth/plugin.ts` | `app.authenticate` preHandler |
| `auth/token-cache.ts` | FIFO verify cache, 10 000 entries |
| `auth/password.ts` | argon2id hash/verify |
| `auth/oauth.ts` | Google JWKS verify, GitHub `/user` + `/user/emails`, GitHub code exchange |
| `app/routes/password.ts` | register / login / reset (dev only) |
| `app/routes/oauth.ts` | `/v1/auth/register`, GitHub exchange proxy |
| `app/routes/refresh.ts` | rotating refresh + theft detection |
| `app/routes/keys.ts` | challenge + bind/rotate + step-up + fence |
| `app/routes/sessionsAdmin.ts` | list / revoke / revoke-others |
| `app/api/pair.ts` | the 4 pairing endpoints |
| `app/socket.ts` | WS handshake auth, expiry timer, `renew-token` |
| `app/machineReauth.ts` | "this machine needs re-login" inference |
| `db/schema.ts` | all tables |

### `packages/cli`
| File | What |
|---|---|
| `auth/login.ts` | `falcon auth login`, `ensureLoggedIn` |
| `auth/pair.ts` | the pairing client (ephemeral keypair, poll, decrypt) |
| `auth/credentials.ts` | `access.key` read/write, `KeyMaterial` union |
| `auth/keyMaterial.ts` | wrap/unwrap dispatch by mode |
| `auth/deviceKey.ts` | OS-vault device key + fallback file |
| `auth/pin.ts` | legacy PIN prompt (read-only path) |
| `auth/tokenProvider.ts` | refresh-token → access-token engine |
| `auth/resolveAccessToken.ts` | one-shot helper for short-lived commands |
| `auth/status.ts` / `logout.ts` / `config.ts` | status, logout, URL resolution |
| `daemon/machineClient.ts` | machine socket, async auth callback, renew timer |
| `session/sessionClient.ts` | session socket, same pattern |
| `daemon/machineIntegration.ts` | daemon boot: credentials → keyTree → DEK |

### `packages/web`
| File | What |
|---|---|
| `lib/session.ts` | in-memory access token, `isSignedIn`, `silentRefresh` |
| `lib/api.ts` | typed fetch wrappers + `ApiError` |
| `lib/oauth.ts` | Google/GitHub redirect builders + callback parsers |
| `lib/complete-password-sign-in.ts` | signup / signin / `rotateKeyEpoch` / `rotateKeyEpochOAuth` |
| `lib/complete-oauth-sign-in.ts` | shared OAuth completion |
| `lib/logout.ts` | 3-step teardown |
| `lib/use-crypto-bridge.ts` | shared refcounted Worker + unlocked flag |
| `lib/use-unlocked-crypto-bridge.ts` | `loading / no-identity / needs-unlock / ready` |
| `lib/pending-pair.ts`, `lib/pending-stepup.ts` | one-shot handoffs |
| `crypto/worker.ts` / `worker-handler.ts` | the Worker: init, unlock, seal/open, `sealForPeer`, `bindKeysProof`, `refreshSession` |
| `crypto/key-storage.ts` | IndexedDB `StoredKeyRecord` |
| `crypto/client.ts` / `protocol.ts` | the postMessage RPC surface |
| `features/auth/require-auth.tsx` | the gate |
| `components/auth/pin-setup-form.tsx` / `pin-unlock-form.tsx` | PIN UI (min 6 chars) |
| `app/(public)/{signin,password,pair,reset-keys}/page.tsx` | the pages |
| `app/(public)/auth/callback/{google,github}/page.tsx` | OAuth landing pages |
| `sync/apiSocket.ts` | socket auth, renew timer, `connect_error` recovery |
| `features/settings/components/DevicesSection.tsx` | device list + revoke |

---

## Appendix — all the magic numbers in one place

| Constant | Value | Where |
|---|---|---|
| access token TTL | 15 min | `server/auth/tokens.ts:17` |
| refresh token TTL | 60 days, absolute | `server/auth/refresh.ts:10` |
| refresh rotation grace | 60 s | `server/app/routes/refresh.ts:15` |
| pair request TTL | 15 min | `server/app/api/pair.ts:17` |
| CLI pairing poll interval | 2 s | `cli/auth/pair.ts` (`pollIntervalMs`) |
| CLI pairing client-side timeout | 15 min | `cli/auth/pair.ts:39` |
| key-bind nonce TTL | 120 s | `server/app/routes/keys.ts:20` |
| password reset token TTL | 1 h | `server/app/routes/password.ts:19` |
| lockout threshold | 5 failures | `server/app/routes/password.ts:28` |
| lockout base / max | 30 s / 15 min | `server/app/routes/password.ts:29` |
| token cache max size | 10 000, FIFO | `server/auth/token-cache.ts:19` |
| `RequireAuth` re-check | 60 s | `web/features/auth/require-auth.tsx:32` |
| web socket renew interval | 10 min | `web/sync/apiSocket.ts:160` |
| CLI machine socket renew | 10 min | `cli/daemon/machineClient.ts:415` |
| `TokenProvider` refresh skew | 60 s | `cli/auth/tokenProvider.ts:21` |
| crypto-bridge release grace | 2 s | `web/lib/use-crypto-bridge.ts:38` |
| minimum PIN length | 6 characters | `web/components/auth/pin-setup-form.tsx:7` |
| CLI PIN attempts (legacy) | 3 | `cli/auth/pin.ts:15` |
| argon2id | 64 MiB, t=3, p=1, 16 B salt, 32 B key | `crypto/pin-params.ts` |
| masterSecret size | 32 bytes | everywhere |
| socket ping timeout / interval | 45 s / 15 s | `server/app/socket.ts:43` |
