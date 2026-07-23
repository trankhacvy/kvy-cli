# Issue #4 — Auth token lifecycle re-architecture (v2)

**Status:** proposed (design + implementation plan) — **revised after independent review**
**Fixes:** [known-issues.md #4](./known-issues.md#issue-4) — no refresh, no revocation, daemon never re-authenticates, WS validated once.
**Scope:** `@falcon/crypto`, `@falcon/wire`, `@falcon/server`, `falcon` (CLI/daemon), `@falcon/web`.

> **v2 changelog (what the review changed):** the refresh-token scheme now actually detects theft (lineage + grace window, §4.3); key-epoch rotation is now a fenced, non-destructive-by-accident operation that can't create split-brain accounts (§6.2); the legacy `POST /v1/auth` challenge route and the recovery-code flows are **explicitly removed** (§5.5, §11); pairing seals the refresh token E2E instead of storing it in plaintext (§6.3); `keys/bind` uses a server-issued nonce (§6.2); WS revocation is genuinely immediate and the 15-min disconnect storm is gone via in-band renewal (§4.5); password **reset + email verification** are designed, not punted (§5.3–5.4); the PIN crypto snippets are corrected (raw-bytes AES-GCM, one portable KDF, no `scryptSync` footgun — §6.1); phasing is reordered so nothing regresses or ships out of dependency order (§8).

---

## 0. The one idea this whole plan turns on

Falcon today **fuses two things that must be separated**:

| Concern | Question | Today | Target |
|---|---|---|---|
| **Authentication** | "Which account is this?" | `signPublicKey` derived from `masterSecret` | email+password **or** Google/GitHub — a real identity |
| **Key custody** | "Can this device *decrypt*?" | same `masterSecret` | `masterSecret` stays client-side, PIN-guarded at rest, moved device→device by pairing |

Split them so identity gets long refresh-token sessions (standard) and the encryption key becomes a per-device secret (crypto-wallet model). Losing the PIN loses **encrypted sessions**, never the **account**. Symmetrically, losing the **password** must not lose the account either — so password accounts get a real reset flow (§5.3), with the honest note that reset restores *access*, not *data* (§5.4).

### Why this is cheap in *this* codebase
1. **`accounts.id` is a random surrogate key** — `machines`, `sessions`, `workspaces` FK to `accounts.id` (`schema.ts:45-47,60-62,75-77`), **not** `signPublicKey`. (Caveat: `unmanagedSessions.accountId` carries no FK constraint — `schema.ts:121` — so it isn't literally *every* table, but nothing FKs `signPublicKey`.) So `signPublicKey` can become rotatable with zero FK churn.
2. **Device-to-device transfer already exists** — `pairRequests` + `/v1/auth/pair*` (`app/api/pair.ts`, `cli/src/auth/pair.ts`, `web/.../pair/page.tsx`, worker `sealForPeer`). This *is* Option 1's key transport.
3. **Pre-launch** — no compat shim needed; **dev databases will be reset** on this migration (no `auth_identities` backfill).

---

## 1. Current state (verified against source)

- `masterSecret` → `deriveKeyTree` (`crypto/src/keys.ts`) → signing (auth) + content (wraps DEKs). Web generates it (`lib/complete-oauth-sign-in.ts`), stores raw in **IndexedDB** (`crypto/key-storage.ts`), derives in a **Worker** (`crypto/worker-handler.ts`). CLI receives it via pairing, stores it **plaintext** in `~/.falcon/access.key` (`cli/src/auth/credentials.ts`).
- Single **HS256 JWT**, **1h TTL**, only `sub=accountId` (`auth/tokens.ts:17`). No refresh, no revocation, no session table.
- **WS validates once at handshake** (`app/socket.ts:57-99`), never re-checks.
- **Daemon retries a fixed token forever** on `disconnect`/`connect_error` (`daemon/machineClient.ts:407-427`) — the silent-death-after-1h bug.
- OAuth is a **recovery binding only** (`app/routes/oauth.ts`); the challenge route `POST /v1/auth` upserts an account **keyed by `signPublicKey`** and mints a claimless token (`app/routes/auth.ts:127-147`) — the fused model that must go.

---

## 2. Target architecture

```
                    ┌──────────────────── ACCOUNT (accounts.id, stable) ────────────────────┐
  IDENTITY (auth)   │  KEY CUSTODY (encryption)                                              │
  auth_identities[] │  key epoch: accounts.signPublicKey / contentPubKey / keyEpoch          │
   • password       │  masterSecret lives ONLY on devices, PIN-wrapped at rest               │
   • google/github  │  moved device→device via pairing (server relays E2E-sealed box)        │
     password reset │  every DEK row is TAGGED with the epoch it was sealed under            │
     (access, not   │  rotation is FENCED: revokes other sessions, old daemons go read-only  │
      data — §5.4)  │  lose all devices+PIN ⇒ rotate epoch (old ciphertext archived, acct ok)│
        │           └────────────────────────────────────────────────────────────────────────┘
        ▼
  device_sessions[]  — refresh-token family per device
    access token: 15m stateless JWT {sub, sid, ct}   (short TTL flips only in P6, §8)
    refresh token: opaque, hashed, rotating with LINEAGE + grace window ⇒ real theft detection
    revocation: immediate on live WS (disconnect by sid); ≤15m on plain HTTP
```

---

## 3. Data-model changes (`packages/server/src/db/schema.ts`)

### 3.1 New: `auth_identities`

```ts
export const authIdentities = pgTable(
  "auth_identities",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'password' | 'google' | 'github'
    identifier: text("identifier").notNull(), // password: lowercased email; oauth: provider subject
    passwordHash: text("password_hash"), // argon2id PHC; null for oauth
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false), // gates account-linking (§5.4)
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.kind, t.identifier), index().on(t.accountId)],
);
```

### 3.2 New: `device_sessions` (with rotation lineage)

```ts
export const deviceSessions = pgTable(
  "device_sessions",
  {
    id: text("id").primaryKey().$defaultFn(createId), // JWT `sid`
    accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    // Current + immediately-previous refresh-token hashes (never the raw token). The previous
    // hash is what makes theft detectable (§4.3) — presenting it after its grace window ⇒ replay.
    refreshTokenHash: text("refresh_token_hash").notNull().unique(),
    previousRefreshTokenHash: text("previous_refresh_token_hash"),
    previousRotatedAt: timestamp("previous_rotated_at"),
    familyId: text("family_id").notNull(),
    clientKind: text("client_kind").notNull(), // 'web' | 'cli-daemon' | 'cli-session' | 'cloud-sandbox'
    label: text("label"),
    machineId: text("machine_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastRefreshedAt: timestamp("last_refreshed_at"), // named honestly: updates on refresh, not every use
    expiresAt: timestamp("expires_at").notNull(),     // absolute lifetime (see §4.6 idle-vs-absolute)
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index().on(t.accountId), index().on(t.familyId), index().on(t.previousRefreshTokenHash)],
);
```

### 3.3 `accounts` — rotatable key material, stable identity

```ts
export const accounts = pgTable("accounts", {
  id: text("id").primaryKey().$defaultFn(createId),
  signPublicKey: text("sign_public_key").unique(), // now NULLABLE + rotatable (was identity anchor)
  contentPubKey: text("content_pub_key"),          // now nullable
  keyEpoch: integer("key_epoch").notNull().default(0), // 0 = no key bound yet; 1 = first bind; +1 per rotation
  headerSeq: integer("header_seq").notNull().default(0),
  settings: bytea("settings"),
  notificationsMutedAll: boolean("notifications_muted_all").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
// NOTE: legacy `oauthProvider`/`oauthSubject` columns are DROPPED (pre-launch; superseded by auth_identities).
```

### 3.4 Tag every DEK-bearing row with its key epoch

Without this, a client cannot tell "sealed under an old epoch (expected)" from "corrupt" — `unwrapDek` returns `null` for both (`crypto/src/dek.ts:30-35`). Add a plaintext `keyEpoch` to each DEK row:

```ts
// machines, sessions, workspaces (and any future DEK-bearing table):
keyEpoch: integer("key_epoch").notNull().default(1), // the epoch this row's `dek` was wrapped under
```

A client on epoch N renders rows with `keyEpoch < N` as **"archived (previous key)"** — a typed, graceful state, not a decrypt error. This is what makes rotation *degrade* instead of *break* (§6.2).

Generate via `pnpm --filter @falcon/server db:generate` (runs on boot, `src/db/migrate.ts`).

---

## 4. Token & session layer

### 4.1 `tokens.ts` — session-scoped claims

```ts
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // STAYS 1h until P6 flips it to 15m (§8 — avoids mid-rollout regression)
export type ClientKind = "web" | "cli-daemon" | "cli-session" | "cloud-sandbox";
export interface TokenPayload { accountId: string; sessionId: string; clientKind: ClientKind; }
export interface VerifiedToken extends TokenPayload { expiresAt: number; }

export async function mintAccessToken(p: TokenPayload, opts: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: p.sessionId, ct: p.clientKind })
    .setProtectedHeader({ alg: ALGORITHM }).setSubject(p.accountId)
    .setIssuedAt(now).setExpirationTime(now + (opts.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS))
    .sign(signingKey(opts.secret));
}
```

`verifyToken` **must reject tokens missing `sid`/`ct`** (any pre-deploy token, or a missed `mintToken` call site) — return `null`, don't default. Access tokens stay stateless (no per-request DB hit; `TokenCache` still applies); revocation is enforced at refresh + WS (§4.3/§4.5).

### 4.2 `issueSession` (`packages/server/src/auth/refresh.ts`)

```ts
import { createHash, randomBytes } from "node:crypto";
const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60d absolute lifetime
export const newRefreshToken = () => randomBytes(32).toString("base64url");
export const hashRefreshToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

export async function issueSession(
  db: Database,
  a: { accountId: string; clientKind: ClientKind; label?: string; machineId?: string },
): Promise<{ accessToken: string; refreshToken: string; sessionId: string }> {
  const refresh = newRefreshToken();
  const rows = await db.insert(deviceSessions).values({
    accountId: a.accountId, refreshTokenHash: hashRefreshToken(refresh), familyId: createId(),
    clientKind: a.clientKind, label: a.label, machineId: a.machineId,
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  }).returning({ id: deviceSessions.id });
  const row = rows[0];
  if (!row) throw new Error("issueSession: insert returned no row"); // noUncheckedIndexedAccess
  const accessToken = await mintAccessToken({ accountId: a.accountId, sessionId: row.id, clientKind: a.clientKind });
  return { accessToken, refreshToken: refresh, sessionId: row.id };
}
```

### 4.3 `POST /v1/auth/refresh` — rotation that actually detects theft

The v1 scheme couldn't catch the real attack (attacker refreshes first → victim's later token is unknown → plain 401, no revocation). v2 keeps the **previous** hash so a stale token maps back to its family, plus a short grace window to absorb multi-tab races.

```ts
const GRACE_MS = 60_000; // two tabs sharing one refresh token both rotate within this window → tolerated

app.post("/v1/auth/refresh", {
  config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  schema: { body: z.object({ refreshToken: z.string().min(1) }),
    response: { 200: z.object({ accessToken: z.string(), refreshToken: z.string() }), 401: ErrorSchema } },
}, async (request, reply) => {
  const presented = hashRefreshToken(request.body.refreshToken);
  const now = new Date();

  // (1) Happy path: presented == current hash. Atomic conditional rotate.
  const next = newRefreshToken();
  const rotated = await db.update(deviceSessions).set({
    refreshTokenHash: hashRefreshToken(next),
    previousRefreshTokenHash: presented,
    previousRotatedAt: now,
    lastRefreshedAt: now,
  }).where(and(
    eq(deviceSessions.refreshTokenHash, presented),
    isNull(deviceSessions.revokedAt),
    gt(deviceSessions.expiresAt, now),
  )).returning();
  const cur = rotated[0];
  if (cur) {
    const accessToken = await mintAccessToken({ accountId: cur.accountId, sessionId: cur.id, clientKind: cur.clientKind as ClientKind });
    return reply.send({ accessToken, refreshToken: next });
  }

  // (2) presented == a PREVIOUS hash. Either a benign multi-tab race (within grace) or replay (theft).
  const prior = await db.query.deviceSessions.findFirst({ where: eq(deviceSessions.previousRefreshTokenHash, presented) });
  if (prior && prior.previousRotatedAt && now.getTime() - prior.previousRotatedAt.getTime() <= GRACE_MS && !prior.revokedAt) {
    // Benign race: hand back the CURRENT credential idempotently (do NOT rotate again).
    const accessToken = await mintAccessToken({ accountId: prior.accountId, sessionId: prior.id, clientKind: prior.clientKind as ClientKind });
    // We cannot return the raw current refresh token (only its hash is stored); return the access token and
    // signal the client to keep its existing refresh token. See client note below.
    return reply.send({ accessToken, refreshToken: request.body.refreshToken }); // client keeps what it has
  }
  if (prior) {
    // Replay of a rotated token outside the grace window ⇒ theft ⇒ revoke the whole family.
    await db.update(deviceSessions).set({ revokedAt: now }).where(eq(deviceSessions.familyId, prior.familyId));
    return reply.code(401).send({ error: "Refresh token reuse detected" });
  }

  // (3) Unknown hash (garbage, or a token from ≥2 rotations ago). Reject; optional deeper history would revoke.
  return reply.code(401).send({ error: "Invalid refresh token" });
});
```

> **Client contract for the grace path:** if `refresh` returns the *same* refresh token the client sent, the client keeps it (a sibling tab already rotated). Clients should also serialize refreshes across tabs via a `BroadcastChannel`/`navigator.locks` lock so the grace path is rare, not the norm.
>
> **Depth:** one level of `previousRefreshTokenHash` catches single-rotation replay — the common theft and race cases. A token replayed from ≥2 rotations back falls to branch (3). If you want to catch that too, replace the two columns with a short `refresh_token_lineage(familyId, hash, retiredAt)` audit table and match any retired hash in the family; the branch logic is identical.

### 4.4 Revocation routes

```ts
// packages/server/src/app/routes/sessions-admin.ts (preHandler: app.authenticate)
GET  /v1/auth/sessions                 // list this account's device_sessions (label as "last refreshed")
POST /v1/auth/sessions/:id/revoke      // set revokedAt + immediately disconnect that session's live sockets (§4.5)
POST /v1/auth/sessions/revoke-others   // revoke all where id != request.sessionId, then disconnect their sockets
```

### 4.5 WebSocket: genuinely-immediate revocation, no disconnect storm

Three changes in `app/socket.ts`, none of which flap the connection on a normal token boundary:

```ts
// (a) At connect: reject a revoked/expired session (cheap single-row lookup).
io.use(async (socket, next) => {
  const verified = await verifyToken(socket.handshake.auth.token as string | undefined ?? "");
  if (!verified) return next(new Error("Invalid authentication token"));
  const s = await db.query.deviceSessions.findFirst({ where: eq(deviceSessions.id, verified.sessionId) });
  if (!s || s.revokedAt || s.expiresAt.getTime() < Date.now()) return next(new Error("Session revoked"));
  socket.data.accountId = verified.accountId;
  socket.data.sessionId = verified.sessionId;
  socket.data.tokenExpiresAt = verified.expiresAt;
  next();
});

// (b) In-band renewal: client refreshes ~1m before exp and emits `renew-token`; server re-validates,
//     updates the expiry deadline, and does NOT drop the socket. Hard disconnect only if no renewal arrives.
io.on("connection", (socket) => {
  let expiryTimer: NodeJS.Timeout;
  const arm = (expEpochSec: number) => {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, expEpochSec * 1000 - Date.now()));
  };
  arm(socket.data.tokenExpiresAt);
  socket.on("renew-token", async (raw: string, ack?: (ok: boolean) => void) => {
    const v = await verifyToken(raw);
    const s = v && (await db.query.deviceSessions.findFirst({ where: eq(deviceSessions.id, v.sessionId) }));
    if (!v || !s || s.revokedAt) { ack?.(false); return socket.disconnect(true); }
    socket.data.tokenExpiresAt = v.expiresAt; arm(v.expiresAt); ack?.(true); // renewed, socket stays up
  });
  socket.on("disconnect", () => clearTimeout(expiryTimer));
});

// (c) Immediate revocation: the revoke routes (§4.4) find live sockets by sessionId and disconnect them now.
//     eventRouter already indexes connections by accountId; add a sessionId filter:
export function disconnectSession(io: Server, accountId: string, sessionId: string) {
  for (const c of eventRouter.connectionsForAccount(accountId)) {
    if (c.socket.data.sessionId === sessionId) c.socket.disconnect(true);
  }
}
```

Result: revocation is **immediate** on live sockets (§9 corrected accordingly); a normal token expiry is handled by silent in-band renewal, so clients do **not** hard-disconnect 4×/hour, and daemons stop flapping machine-presence every 15 minutes. `connectionsForAccount` is a thin accessor over the map `eventRouter` already maintains (`app/events/eventRouter.ts`).

### 4.6 Lifetime policy

`expiresAt` is an **absolute** 60-day lifetime (a daily-active daemon still re-runs `falcon auth login` every 60 days). If you want sliding/idle expiry instead, extend `expiresAt` on each successful refresh — decide explicitly; the plan defaults to absolute for a bounded worst case. State the choice in `docs/encryption.md`.

---

## 5. Identity layer — email/password + OAuth + reset

### 5.1 Password hashing (`packages/server/src/auth/password.ts`)

```ts
import { hash, verify } from "@node-rs/argon2"; // argon2id
export const hashPassword = (pw: string) => hash(pw);          // PHC string (salt+params embedded)
export const verifyPassword = (phc: string, pw: string) => verify(phc, pw);
```

### 5.2 Register / login (rate-limited, no enumeration oracle)

```
POST /v1/auth/password/register {email, password} → issueSession → {accessToken, refreshToken}
POST /v1/auth/password/login    {email, password} → verify → issueSession
```

- **Every** route sets `config: { rateLimit: { max: 10, timeWindow: "1 minute" } }` (match existing `auth.ts:98`), and login adds a per-identity failure counter → temporary lockout.
- **No enumeration:** register must not reveal "email already exists" via a distinct 409. Return a generic success shape and, if the email is taken, send a "you already have an account" email out-of-band instead of a discriminating status. Login returns one generic "invalid email or password."
- On register, send a **verification email** (see §5.4); the account is usable immediately but `emailVerified=false` until confirmed.

### 5.3 Password reset (designed, not punted)

```
POST /v1/auth/password/reset/request {email}          → always 200 (no enumeration); if identity exists, email a single-use token
POST /v1/auth/password/reset/confirm {token, password} → set new passwordHash; revoke ALL device_sessions for the account
```

Requires transactional email infra — this is a **new dependency** and its own phase (§8, P2). If a self-host box has no email configured, password reset is disabled and the UI says so; OAuth remains the recoverable path.

### 5.4 The honest E2E consequence of reset (and the account-linking rule)

**Reset restores account *access*, not *data*.** After a password reset the user is authenticated but, on a new device, holds **no `masterSecret`** — so they must either **pair from a device that still has the key**, or **start a new key epoch** (§6.2), losing old encrypted sessions. This must be stated plainly in the reset-complete UI. It is strictly the same trade-off as the PIN: identity is recoverable, E2E data is only as recoverable as the key.

**Account-linking is gated on verified email.** §5.4's "same email ⇒ same account" is only safe if both sides are verified — otherwise it's pre-registration takeover (register `victim@gmail.com` before they ever use Google). Rule: an OAuth login links to an existing password account **only if** that account's email is `emailVerified` **and** the OAuth provider asserts the same verified email; otherwise create a separate account and offer explicit, authenticated linking (`POST /v1/auth/identities`). Linking is post-MVP; the guard is not.

### 5.5 OAuth promoted to login; legacy challenge route removed

- Change `POST /v1/auth/register` (`app/routes/oauth.ts`) to **find-or-create by `auth_identities(kind, subject)`** and call `issueSession` (not `mintToken`); drop the `signPubKey`/`contentPubKey` requirement — key binding is now separate (§6.2).
- **Delete `POST /v1/auth`** (`app/routes/auth.ts`) and its web callers: `lib/complete-challenge-sign-in.ts`, the `signIn` wrapper (`lib/api.ts`), and the **recovery-code flows** (`lib/restore-recovery-code.ts`, `exportRecoveryCode`/`encodeRecoveryCode` usage in `crypto/worker-handler.ts`, `components/auth/recovery-code-*`, `features/settings/.../RecoverySection.tsx`). Leaving `/v1/auth` alive resurrects the fused, claimless-token model as a backdoor. Removal is coordinated with the web migration (same phase — §8, P4) so the client stops calling it before the route disappears.

---

## 6. Key custody — PIN wrapping + fenced rotation (Option 1)

### 6.1 New crypto module: PIN-wrap the masterSecret (corrected)

```ts
// packages/crypto/src/pin.ts (+ pin.web.ts for the platform-native primitives)
export interface PinWrapped { v: 1; kdf: "argon2id"; salt: string; nonce: string; ct: string; } // base64 fields

export function wrapWithPin(masterSecret: Uint8Array, pin: string): PinWrapped;
export function unwrapWithPin(w: PinWrapped, pin: string): Uint8Array | null; // null on wrong PIN — never throws
```

Corrections vs v1:
- **One KDF, both platforms: argon2id.** Web uses libsodium `crypto_pwhash` (already shipped); node uses `@node-rs/argon2`'s raw KDF with **identical params**. Same params + salt + PIN ⇒ identical 32-byte key on both — so a blob *is* portable and the parity test in §10 is valid. (Drops v1's `scryptSync(…, {N:2**16})`, which throws — 64 MiB > node's 32 MiB default `maxmem`.)
- **Raw-bytes AES-GCM, not `encryptWithDataKey`.** The existing `encrypt*` helpers `JSON.stringify` their input (`encryption.ts:206`, `encryption.web.ts:155`), so a `Uint8Array` would round-trip as `{"0":…}`, not bytes. The PIN module encrypts the raw 32 bytes directly: node `crypto.createCipheriv("aes-256-gcm", key, nonce)`, web `crypto.subtle.encrypt({name:"AES-GCM", iv:nonce}, key, secret)`. Fresh random 12-byte nonce per wrap.

Export from `index.ts` / `index.web.ts`.

**PIN honesty (§9 aligned):** an attacker who has the device *has the blob*; a client-side attempt counter does not bind the ciphertext, so this is an **offline** brute-force at KDF speed. A 6-digit PIN at moderate argon2id params falls in hours on one GPU-less machine. So the honest claim is: **"the PIN protects against casual/opportunistic access to a lost or shared device; it is not a defense against a determined offline attacker."** Encourage a longer alphanumeric passphrase for users who want more; never imply lockout makes a short PIN strong.

### 6.2 `keys/bind` — fenced bind/rotate (no split-brain, no replay)

```ts
// packages/server/src/app/routes/keys.ts (preHandler: app.authenticate)
// Step 1: client asks for a server nonce (defeats the replayable client-chosen challenge of v1).
app.post("/v1/auth/keys/challenge", async (req, reply) => {
  const nonce = randomBytes(32).toString("base64");
  await db.insert(keyBindNonces).values({ accountId: req.accountId, nonce, expiresAt: new Date(Date.now() + 120_000) });
  return reply.send({ nonce });
});

// Step 2: bind or rotate. Signature covers accountId || contentPubKey || server nonce (not a bare client value).
app.post("/v1/auth/keys/bind", {
  schema: { body: z.object({ signPubKey: z.string(), contentPubKey: z.string(), nonce: z.string(), signature: z.string(),
                             rotate: z.boolean().optional(), stepUpProof: z.string().optional() }) },
}, async (req, reply) => {
  const n = await consumeNonce(db, req.accountId, req.body.nonce); // single-use, unexpired, this account
  if (!n) return reply.code(401).send({ error: "Invalid or expired nonce" });
  const pk = decodeBase64(req.body.signPubKey);
  const signed = concatBytes(utf8(req.accountId), decodeBase64(req.body.contentPubKey), decodeBase64(req.body.nonce));
  if (!tweetnacl.sign.detached.verify(signed, decodeBase64(req.body.signature), pk))
    return reply.code(401).send({ error: "Invalid signature" });

  const acct = await db.query.accounts.findFirst({ where: eq(accounts.id, req.accountId) });
  const isFirstBind = acct!.keyEpoch === 0;
  const sameKey = acct!.signPublicKey === toHex(pk);

  if (!isFirstBind && !sameKey) {
    // ROTATION — destructive & fenced:
    if (!req.body.rotate) return reply.code(409).send({ error: "Key mismatch; rotation must be explicit" });
    if (!(await verifyStepUp(db, req.accountId, req.body.stepUpProof)))        // re-enter password / re-do OAuth
      return reply.code(401).send({ error: "Step-up required to rotate keys" });
    if (await hasOtherHealthySessions(db, req.accountId, req.sessionId))       // interlock
      return reply.code(409).send({ error: "Other devices are online — pair from one instead of rotating" });
  }

  // Conflict: this key already belongs to another account (unique constraint) → clean 409, not a 500.
  const conflict = await db.query.accounts.findFirst({ where: and(eq(accounts.signPublicKey, toHex(pk)), ne(accounts.id, req.accountId)) });
  if (conflict) return reply.code(409).send({ error: "Key already bound to another account" });

  await db.transaction(async (tx) => {
    await tx.update(accounts).set({
      signPublicKey: toHex(pk), contentPubKey: req.body.contentPubKey,
      keyEpoch: isFirstBind ? 1 : sameKey ? acct!.keyEpoch : acct!.keyEpoch + 1, // no bump on idempotent re-bind
    }).where(eq(accounts.id, req.accountId));
    if (!isFirstBind && !sameKey) {
      // Fence the split-brain: kill every OTHER session so stale daemons can't keep writing to the dead epoch.
      await tx.update(deviceSessions).set({ revokedAt: new Date() })
        .where(and(eq(deviceSessions.accountId, req.accountId), ne(deviceSessions.id, req.sessionId)));
    }
  });
  return reply.send({ success: true, keyEpoch: /* new epoch */ });
});
```

**How this kills the split-brain the review found:** on rotation we (1) require explicit `rotate` + step-up + an interlock that blocks rotating while healthy devices are online, and (2) **revoke all other sessions in the same transaction**. A stale daemon still holding the old `masterSecret` therefore loses its session on next refresh/reconnect, is forced through `falcon auth login` → re-pair → receives the **new** `masterSecret`, and `machineIntegration.ts` already mints a fresh DEK when it can't unwrap the previous one (`:306-319`) — so it resumes writing under the new epoch. Old rows keep their `keyEpoch` tag (§3.4) and render as **"archived (previous key)"**, never as errors. Rotation degrades; it doesn't corrupt.

### 6.3 Flows

**A. Sign-up (first device):** register (password/OAuth) → account + session (no key) → generate `masterSecret` → **set PIN** → `wrapWithPin` stored locally → `keys/challenge` + `keys/bind` (epoch 1). **No recovery code shown; nothing to copy.**

**B. Same device, returning:** login → session → **enter PIN** → `unwrapWithPin` → key in worker/daemon memory.

**C. New device (no local key):** login → session (authenticated, no key) → choose:
- **Pair from an existing device** — reuse `/v1/auth/pair`. The approver seals **both** the `masterSecret` **and** the new device's refresh token into the E2E box (§6.3 pairing change below). New device sets a PIN, wraps, stores.
- **No other device → rotate epoch** — flow of §6.2 (destructive, fenced). Old sessions archived; account intact — the user's stated "lost PIN ⇒ lost sessions, not account."

**Pairing change (fixes the plaintext-refresh-token escalation):** today `/pair/approve` calls `mintToken` and the server stores the resulting token in the **plaintext** `pairRequests.token` column (`schema.ts:139`), served back over the **unauthenticated** poll (`pair.ts:91-97`). Switching that to a 60-day refresh token in plaintext is a real regression. Instead:
- The **approver** (an authed device) calls `issueSession(...)` **client-side is impossible** — so the server mints the session, but returns the refresh token to the approver, who **seals it into the same E2E box** as the `masterSecret` (extend the sealed payload from `[0x00|masterSecret]` to `[0x01|masterSecret|refreshToken]`). The server stores only the **hash** of the refresh token in `device_sessions` and an **opaque sealed blob** in `pairRequests.response`; the plaintext `pairRequests.token` column is **dropped**. The pending row is **deleted on first authorized pickup** (single-use). The new device opens the box with its ephemeral key and gets both secrets. Server never holds the raw refresh token — consistent with §3.2.

### 6.4 Web changes
- `crypto/key-storage.ts`: store `PinWrapped`, not raw bytes.
- `crypto/worker-handler.ts`/`client.ts`/`protocol.ts`: `init(masterSecret, pin)` saves `wrapWithPin`; new `unlock(pin)` loads+unwraps into memory; a no-key worker requires `unlock`. Remove `exportRecoveryCode`.
- **Refresh-token custody:** do **not** claim IndexedDB is safer than `localStorage` — in page context both are equally script-readable. Prefer an **httpOnly, Secure, SameSite refresh cookie** (the server already runs credentialed CORS — `socket.ts:35-40`) so XSS can't read it; the access token stays in memory. If a cookie is infeasible for the split-origin static export, keep the refresh token **inside the crypto worker** and perform refresh from the worker. Cross-tab refresh serialized via `navigator.locks`.
- `features/auth/require-auth.tsx`: on a would-be redirect, attempt **one silent refresh** first; only redirect to `/signin/` if refresh fails.
- `sync/apiSocket.ts`/`socket-factory.ts`: proactive `renew-token` ~1m before exp (§4.5) and a single silent refresh on an auth `connect_error` before surfacing `authError`.

### 6.5 CLI / daemon changes — honest about the headless reality

A headless daemon that self-starts on reboot **cannot** prompt for a PIN, and any machine running the daemon must keep a machine-openable key on the same disk anyway (daemon-spawned session processes read credentials with no human present — `start.ts:334`). So:

- **The daemon default is reduced custody: store the *content bundle*, not the full `masterSecret`** (the `credentials.ts:15-18` shape already anticipates this). The box can decrypt session data but cannot derive the signing key or mint new pairings — smaller blast radius on a compromised dev box. The content bundle is wrapped with an **OS-keychain device key** (macOS Keychain / libsecret / DPAPI) where available.
- **Be blunt about the limit:** on the primary target (headless Linux over SSH) libsecret usually has no unlocked keyring, so the honest fallback is today's `0600` file — meaning **this phase delivers little at-rest improvement on daemon boxes.** The PIN's real beneficiary is the **web/interactive** client, not the daemon. Say this in `docs/encryption.md` rather than implying otherwise.
- **Interactive `falcon` foreground** may still PIN-wrap its own copy for at-rest protection when a human is present.

```ts
// packages/cli/src/auth/credentials.ts — new shape (dev DBs reset; no compat shim)
const CredentialsSchema = z.object({
  refreshToken: z.string().min(1),                 // was `token` (1h JWT) → rotating refresh token
  keyMaterial: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("pin"), wrapped: PinWrappedSchema }),          // interactive
    z.object({ mode: z.literal("device"), wrapped: DeviceWrappedSchema }),    // daemon, OS-keychain
    z.object({ mode: z.literal("plaintext-fallback"), bundle: z.string() }),  // documented 0600 fallback
  ]),
});
```

### 6.6 Daemon re-auth (fixes silent death) — and the real scope

`machineClient.ts` passes a fixed token and retries verbatim. Replace with a `tokenProvider` that mints access tokens from the refresh token (`POST /v1/auth/refresh`), caches until ~1m before exp, persists each rotation back to `access.key`, and on a `401`/revoked refresh logs **"re-authentication required — run `falcon auth login`"** instead of looping a dead credential:

```ts
const socket = deps.ioFactory(deps.serverUrl, {
  path: "/v1/stream", transports: ["websocket"],
  auth: async (cb) => cb({ token: await deps.tokenProvider.getAccessToken(), clientType: "machine-scoped", machineId: identity.machineId }),
});
socket.on("connect_error", async (err) => {
  deps.logger.warn("[machine-client] connect error", { error: err.message });
  if (/authentication token|Session revoked/i.test(err.message)) await deps.tokenProvider.forceRefresh();
});
// plus: proactive `renew-token` emit ~1m before access-token exp (mirrors §4.5) so the socket never drops on expiry.
```

**Scope (bigger than v1 admitted):** the static `token: string` is threaded through many more surfaces than machineClient — `session/sessionClient.ts:46,107`, `daemon/blobClient.ts`, `daemon/unmanagedSessionClient.ts`, `daemon/githubChecks.ts`, `api/sessionMetadata.ts`, `commands/{start,startCodex,sessionsList,github}.ts`. All take `token` by value and must take a `tokenProvider` (or an async getter) instead. Budget P5 accordingly.

---

## 7. Cloud sandbox (requirement 4) — forward hook, unchanged

A cloud sandbox must read the repo and run the agent in **plaintext** — E2E is impossible for those sessions by definition, so it's a **per-session property**, not a global compromise. A sandbox is just another device: a `device_sessions` row with `clientKind:"cloud-sandbox"` + `machineId`, authenticating via the same refresh/access machinery (no new auth path). Local sessions stay E2E; cloud sessions use a server-held or sandbox-wrapped DEK, flagged via the reserved `workspaces.syncEnabled`/`sandboxConfig` columns. Revocation/expiry come for free from `device_sessions`. Built later (§8, P7).

---

## 8. Rollout phases (reordered so nothing regresses or ships out of order)

| Phase | Deliverable | Packages | Depends | Notes |
|---|---|---|---|---|
| **P1** | Schema (`auth_identities`, `device_sessions` w/ lineage, `keyEpoch` on accounts **and DEK rows**, drop legacy oauth cols); `issueSession`; `/v1/auth/refresh` (lineage+grace); `password.ts` | server, wire | — | **Access TTL stays 1h** — no behavior change yet |
| **P2** | Email/password register+login+**reset** (+ email infra dep); OAuth resolves via `auth_identities`; `keys/challenge`+`keys/bind` (server-nonce, fenced); `/pair/approve`→`issueSession` w/ **E2E-sealed** refresh token; drop `pairRequests.token` | server, wire | P1 | pairing now issues sessions ⇒ unblocks CLI |
| **P3** | `wrapWithPin`/`unwrapWithPin` (argon2id both platforms, raw AES-GCM) + tests | crypto | — | parallel with P1/P2 |
| **P4** | Web: PIN set/unlock, store `PinWrapped`, refresh custody (httpOnly cookie / worker), silent refresh, "new device" chooser, **remove recovery-code + challenge-sign-in flows**; **then delete server `/v1/auth`** | web, server | P2, P3 | route deletion coordinated here so no client still calls it |
| **P5** | CLI: new credentials shape, `tokenProvider` threaded through **all** token consumers (§6.6), daemon re-auth + `renew-token`, reduced-custody default, pairing PIN prompt | cli | P2, P3 | |
| **P6** | Flip access TTL → **15m**; WS in-band `renew-token` + expiry timer + **immediate revoke-disconnect**; session-admin + revoke-others UI | server, web, cli | P4, P5 | short TTL flips only after refresh consumers exist |
| **P7** | Cloud-sandbox `clientKind` + per-session key custody | server | P1–P6 | deferred; design only |

Each phase keeps builds green **and** behavior non-regressing: the 1h→15m TTL flip (the one change that would degrade UX without refresh) is held to P6, after web (P4) and CLI (P5) can silently refresh.

---

## 9. Security notes & honest limitations (corrected)

- **Access tokens are stateless.** Revocation is **immediate on live WebSockets** (revoke route disconnects by `sid`, §4.5c) and **≤ the access TTL** on plain HTTP (1h until P6, then 15m). Documented, bounded.
- **Refresh theft** is detected by rotation + **previous-hash lineage** with a 60s grace window (§4.3): a stolen-then-rotated token replayed by the victim (or the attacker) outside the window revokes the whole family. One-level lineage catches single-rotation replay; a lineage table extends it to deeper replay.
- **PIN entropy is low and the blob is offline-attackable by anyone holding the device** — it protects against casual access, not a determined offline attacker (§6.1). Never uploaded to the server (that would make it server-brute-forceable — the reason Option 2 was rejected).
- **Daemon at-rest custody is weak by necessity** — a headless self-starting daemon can't use a human PIN; reduced-custody content bundle + OS-keychain where available, `0600` fallback otherwise. The PIN benefits interactive clients, not daemons (§6.5).
- **Key rotation is destructive but fenced** — explicit intent + step-up + online-device interlock + same-transaction revocation of other sessions + epoch-tagged rows ⇒ archived-not-corrupted. No silent split-brain.
- **Password reset restores access, not E2E data** (§5.4) — same trade-off as the PIN. Account-linking requires verified email (no pre-registration takeover).
- **Web remains the weaker E2E endpoint** (served code, design §5.3) — the PIN improves at-rest posture, not the served-JS trust boundary.
- **Env-var mismatch footgun — resolved (security-review remediation pass, §13 nit).** CLI resolves `FALCON_BACKEND_URL` (`cli/src/auth/config.ts:17`); web now has exactly one canonical var, `lib/config.ts`'s `API_URL` (backed by `NEXT_PUBLIC_API_URL`) — `NEXT_PUBLIC_FALCON_API_URL` does not exist in the codebase and every web module that talks to the server (`lib/api.ts`, `sync/socket-factory.ts`, `crypto/worker-handler.ts`) imports the same `API_URL`.
- **Refresh token custody — resolved (security-review remediation pass, finding F1, §13).** The refresh token no longer sits in `localStorage` (a 60-day, XSS-readable, full-account credential) — it's PIN-wrapped in IndexedDB and recovered only into the crypto worker's own memory, never the main thread. See §13 for the chosen design and rationale.

## 10. Testing

- **crypto:** `pin.test.ts` — round-trip, wrong-PIN→null, **cross-platform argon2id vector parity** (now valid because both platforms use identical params), nonce uniqueness.
- **server:** refresh happy-path rotation; **stolen-token replay outside grace → family revoked**; multi-tab replay inside grace → tolerated (idempotent); revoked session rejected at WS connect **and disconnected live**; `renew-token` keeps a socket up across expiry; `keys/bind` rejects replayed nonce, rejects rotation without step-up/while devices online, returns 409 on key-owned-by-another; password register/login rate-limited + no enumeration; reset revokes all sessions; OAuth links only on verified email.
- **cli:** `tokenProvider` refresh+persist+rotate; daemon re-auth after forced 401; credentials new-shape round-trip for all three key-material modes; dead-refresh → clear "run falcon auth login" message.
- **web:** unlock (PIN→worker); silent refresh replaces redirect; new-device chooser; revoke-others; recovery-code UI is gone.

## 11. File-by-file change list

**server:** `db/schema.ts` (+`authIdentities`,`deviceSessions`,`keyBindNonces`; `accounts` nullable signPublicKey + `keyEpoch`, **drop `oauthProvider`/`oauthSubject`**; `keyEpoch` on `machines`/`sessions`/`workspaces`; **drop `pairRequests.token`**; +`authIdentities.failedLoginCount`/`lockedUntil`, finding F3, `drizzle/0005_broad_wong.sql`) · `auth/tokens.ts` (claims, `mintAccessToken`, reject missing `sid`/`ct`) · `auth/refresh.ts` *(new)* · `auth/password.ts` *(new; F3 login-lockout logic added in the remediation pass)* · `auth/email.ts` *(new — reset/verify send)* · `app/routes/{refresh,password,keys,sessions-admin}.ts` *(new)* · `app/routes/oauth.ts` (resolve via identities, `issueSession`) · **delete `app/routes/auth.ts`** (§5.5, in P4) · `app/api/pair.ts` (`issueSession` + E2E-sealed refresh token, single-use delete, drop plaintext token) · `app/socket.ts` (connect revocation check, `renew-token`, expiry timer, `disconnectSession`) · `app/events/eventRouter.ts` (`connectionsForAccount`) · `auth/plugin.ts` (`sessionId`/`clientKind` decorators).

**crypto:** `pin.ts`/`pin.web.ts` *(new)* + `index(.web).ts` exports · `pin.test.ts` · **remove** `encodeRecoveryCode`/`decodeRecoveryCode` exports once web drops them (keep the file until P4 lands).

**wire:** schemas for refresh/password/reset/keys/sessions-admin bodies + `PinWrapped`/`DeviceWrapped` + the extended pairing sealed-payload version.

**cli:** `auth/credentials.ts` (new discriminated shape) · `auth/tokenProvider.ts` *(new; Zod-validates the refresh response as of the remediation pass)* · `auth/pin.ts` *(new)* · `auth/deviceKey.ts` *(new, OS keychain)* · `auth/login.ts` (post-pair PIN prompt, new shape) · `daemon/machineClient.ts` + **all token consumers** in §6.6 (thread `tokenProvider`) · `daemon/machineIntegration.ts` (unlock via PIN/device key; reduced-custody default).

**web:** `crypto/{key-storage,worker-handler,client,protocol}.ts` (`PinWrapped`, `unlock`, remove recovery; **remediation pass:** `wrappedRefreshToken`, `setRefreshToken`/`refreshSession` requests, worker-side `/v1/auth/refresh` fetch) · `lib/session.ts` (**rewritten, finding F1** — in-memory access token, no `localStorage`, `silentRefresh()` now calls the worker) · `lib/complete-oauth-sign-in.ts`/`complete-password-sign-in.ts` + `components/auth/oauth-callback-page.tsx`/`app/(public)/password/page.tsx` (thread the refresh token to `bridge.setRefreshToken` post-unlock, finding F1) · `lib/use-crypto-bridge.ts` (+`getSharedCryptoBridge()` peek accessor, finding F1) · **delete** `lib/complete-challenge-sign-in.ts`, `lib/restore-recovery-code.ts`, `components/auth/recovery-code-*`, `features/settings/.../RecoverySection.tsx` · `features/auth/require-auth.tsx` (silent refresh before redirect; crypto-unlock gate now precedes it, finding F1) · `sync/apiSocket.ts` (renew + refresh-on-authError; **remediation pass:** widened the connect_error
auth-shaped-error regex to also match `"Session revoked"`, a live bug found testing F2 — see §13) ·
`features/settings/components/DevicesSection.tsx` *(new, finding F2)* — device-sessions list + log-out-this-device/log-out-others, wired into `features/settings/sections.tsx`.

---

## 12. Implementation TODO

Granular, checkable task list. Each phase ends with a **green gate** (`pnpm build && pnpm typecheck && pnpm test && pnpm lint`) and the phase's own acceptance check. Tasks are ordered within a phase; `[wire]`/`[server]`/`[crypto]`/`[cli]`/`[web]` tag the package. Do **not** start until the plan is approved.

### Phase 0 — Prep & decisions (no code)
- [x] Confirm **dev databases will be reset** (no `auth_identities` backfill) and announce it — existing key-only accounts become unreachable after P4. **Decision:** confirmed; local dev Postgres is disposable pre-launch, no backfill migration will be written.
- [x] Pick the transactional **email provider** for reset/verify (P2 dependency); add its env vars to `config.ts` design (e.g. `SMTP_URL` / provider API key). If none, decide the "reset disabled, OAuth-only recovery" fallback copy. **Decision:** `auth/email.ts` ships a small `EmailTransport` interface with a no-op/dev-logger transport as the default (logs the verify/reset link at `info` level) so the flow is fully testable without real SMTP; a real transport is pluggable later via `SMTP_URL` env (read, not yet implemented — logs a "not configured, using dev logger" notice instead of silently no-op-ing).
- [x] Add the `@node-rs/argon2` dependency decision (server + CLI PIN KDF) and confirm a matching **argon2id** primitive/params on the web side (libsodium `crypto_pwhash`) for blob portability. **Decision:** `@node-rs/argon2` added to `@falcon/crypto` (PIN KDF, node) and used directly by `@falcon/server`'s `auth/password.ts` (password hashing, PHC string). Web/browser argon2id uses `libsodium-wrappers-sumo` (not the slim `libsodium-wrappers` already in use elsewhere) because `crypto_pwhash` is sumo-only. Params unified in `packages/crypto/src/pin-params.ts` (memoryCost 64MiB, timeCost 3, parallelism 1, 16-byte salt matching libsodium's fixed `crypto_pwhash_SALTBYTES`) — verified byte-identical output both directions in `pin.test.ts`'s cross-platform parity vectors.
- [x] Unify the client server-URL env var (`FALCON_BACKEND_URL` vs `NEXT_PUBLIC_FALCON_API_URL` vs `NEXT_PUBLIC_API_URL`) — pick one canonical name per client, document, plan the startup log line. **Decision (superseded — see security-review remediation §13 nit):** the note originally on this line said web would standardize on `NEXT_PUBLIC_FALCON_API_URL`; what actually shipped, and is what the code uses today, is the opposite — `lib/config.ts`'s `API_URL` (backed by `NEXT_PUBLIC_API_URL`) is the one canonical web env var, and `NEXT_PUBLIC_FALCON_API_URL` does not exist anywhere in the codebase. This was a real split-brain bug in practice, not just a stale doc note: `sync/socket-factory.ts` read the nonexistent `NEXT_PUBLIC_FALCON_API_URL` name until the Phase 4 live-testing pass caught and fixed it (bug #1 below), and `crypto/worker-handler.ts`'s F1 `refreshSession` now imports the same `API_URL` too. CLI keeps `FALCON_BACKEND_URL` (already canonical there) — no change on that side.
- [x] Decide refresh-token **lifetime policy**: absolute 60d (default) vs sliding — record in `docs/encryption.md` draft. **Decision:** absolute 60-day lifetime (plan default), recorded in `docs/encryption.md`.
- [x] Decide daemon default custody: **reduced-custody content bundle** (recommended) vs full masterSecret. **Decision:** reduced-custody content bundle is the daemon default (§6.5); interactive `falcon` foreground may still PIN-wrap the full `masterSecret`.

### Phase 1 — Server session/refresh foundation (no behavior change; access TTL stays 1h)
Schema
- [x] `[server]` `schema.ts`: add `authIdentities` table (§3.1) incl. `emailVerified`.
- [x] `[server]` `schema.ts`: add `deviceSessions` table with lineage columns (`previousRefreshTokenHash`, `previousRotatedAt`, `familyId`, `machineId`, `revokedAt`, `expiresAt`, `lastRefreshedAt`) + indexes (§3.2).
- [x] `[server]` `schema.ts`: `accounts` → make `signPublicKey`/`contentPubKey` nullable, add `keyEpoch` default 0, **drop `oauthProvider`/`oauthSubject`** (§3.3).
- [x] `[server]` `schema.ts`: add `keyEpoch` (default 1) to `machines`, `sessions`, `workspaces` (§3.4).
- [x] `[server]` `schema.ts`: add `keyBindNonces` table (accountId, nonce, expiresAt) for §6.2. Also added `passwordResetTokens` (needed by Phase 2's reset flow, not explicitly named in §3 but same shape).
- [x] `[server]` `db:generate` migration (`drizzle/0002_rapid_richard_fisk.sql`, generated interactively via tmux to resolve drizzle-kit's column-rename-vs-drop+add ambiguity prompts — accepted "create column" for all, since these are genuinely new columns, not renames); migrate-on-boot idempotency unchanged (`db/migrate.ts` untouched).
- [x] `[server]` update `db/schema.test.ts` for new tables/columns.

Tokens & refresh
- [x] `[server]` `auth/tokens.ts`: `ClientKind`, `TokenPayload{accountId,sessionId,clientKind}`, `mintAccessToken` with `sid`/`ct` claims; kept `ACCESS_TOKEN_TTL_SECONDS = 1h`. **Deviation:** `mintToken` (old bare-accountId API) was removed rather than kept alongside — every caller (auth.ts, oauth.ts, pair.ts, tests) was migrated to `mintAccessToken`/`issueSession` in the same pass, since keeping both would let the fused, claimless-token model keep shipping through the legacy routes.
- [x] `[server]` `auth/tokens.ts`: `verifyToken` returns `sessionId`/`clientKind`; **rejects tokens missing `sid`/`ct`** (→ null). `tokens.test.ts` updated + a dedicated "rejects a pre-issue-4 token" case added.
- [x] `[server]` `auth/token-cache.ts`: no code change needed — it's generic over `VerifiedToken`, so the new claims flow through automatically; `token-cache.test.ts` updated to construct the richer payload shape.
- [x] `[server]` `auth/refresh.ts` *(new)*: `newRefreshToken`, `hashRefreshToken`, `issueSession` (§4.2) — `noUncheckedIndexedAccess`-safe (`.returning()[0]` guarded). Unit-tested via `refresh.test.ts`.
- [x] `[server]` `auth/password.ts` *(new)*: `hashPassword`/`verifyPassword` (argon2id via `@node-rs/argon2`). Covered by `password.test.ts`'s route-level tests (no bare unit test file — exercised end-to-end through register/login/reset).
- [ ] `[wire]` schemas: `RefreshRequest`/`RefreshResponse`; `DeviceSession` row shape for admin list. **Deviation (deliberate):** every other HTTP route in this codebase (`auth.ts`, `oauth.ts`, `pair.ts`) defines its Zod request/response schemas locally in the route file, not in `@falcon/wire` — `@falcon/wire` is reserved for the cross-package encrypted wire protocol (session envelopes, RPC, updates), not plain HTTP bodies. Followed that real convention instead of the plan's illustrative placement: refresh/password/keys schemas are defined locally in `app/routes/{refresh,password,keys}.ts`.
- [x] `[server]` `app/routes/refresh.ts` *(new)*: `POST /v1/auth/refresh` — atomic rotate, grace-window branch, replay→family-revoke, unknown→401 (§4.3). Registered in `server.ts`.
- [x] `[server]` `auth/plugin.ts`: decorates `request.sessionId`/`request.clientKind` from the verified token.

Tests / gate
- [x] `[server]` `refresh.test.ts`: happy rotate; replay-outside-grace → family revoked; replay-inside-grace → idempotent (echoes the same token back); unknown → 401; revoked/expired row → 401. 7/7 passing.
- [x] **Gate:** `pnpm --filter @falcon/server build/typecheck/test` green (46 files, 349 tests, includes real-Postgres integration tests). Lint not yet run repo-wide at this checkpoint (see Phase-6-end full-repo gate). **Acceptance:** refresh works end-to-end via HTTP; 1h token TTL unchanged.

### Phase 2 — Identity routes, key-bind, pairing issues sessions
Email/OAuth identity
- [x] `[server]` `auth/email.ts` *(new)*: dev-logger `EmailTransport` (Phase 0 decision) — logs verify/reset links; no real SMTP transport wired yet (documented gap, not silently swallowed).
- [ ] `[wire]` schemas: password register/login/reset-request/reset-confirm bodies + responses. Same deviation as Phase 1's refresh schemas — defined locally in `app/routes/password.ts`, matching the codebase's real convention.
- [x] `[server]` `app/routes/password.ts` *(new)*: register (rate-limited, no-enumeration — same generic success shape + out-of-band notice either way, `issueSession`), login (rate-limited, generic invalid-email-or-password error), reset/request (always-200), reset/confirm (set hash, **revoke all sessions**) (§5.2–5.3). **Resolved (security-review remediation pass, finding F3 — see §13):** per-identity login lockout is now implemented — `authIdentities` gained `failedLoginCount`/`lockedUntil` columns (`drizzle/0005_broad_wong.sql`); a wrong password increments the counter and, past a threshold of 5 consecutive failures, sets an exponentially-growing lockout (30s base, doubling per extra failure, capped at 15 minutes); a locked identity gets the exact same generic 401 as a wrong password, even when the password submitted is actually correct (no lock-vs-wrong-password oracle); a correct login clears both fields. This is in addition to, not instead of, the existing per-route IP rate limit — it closes the gap that rate limit alone left open (an attacker rotating IPs against one known email).
- [x] `[server]` `app/routes/oauth.ts`: resolve/create by `auth_identities(kind,subject)`; `issueSession` not `mintToken`; dropped `signPubKey`/`contentPubKey` from the body entirely (key binding is now a separate step). **Deviation:** the verified-email account-linking guard (§5.4) is **not implemented** — `verifyGoogleIdToken`/`verifyGithubAccessToken` don't currently surface the provider's email/email_verified claim at all, so there is nothing to link on yet; each OAuth provider today always resolves to its own distinct `auth_identities` row (confirmed by a dedicated test: "different OAuth providers for the same person create distinct accounts"). This is a real, intentional scope cut — implementing the guard properly needs the email-surfacing plumbing first.
- [x] `[server]` `app/routes/password.test.ts` (9 tests), `oauth.test.ts` (rewritten for the new identity-resolution behavior, 7 tests): enumeration-safety, reset-revokes-sessions, and the no-cross-provider-linking behavior are covered; rate-limit and lockout are not (no lockout to test, and the existing rate-limit config is unchanged/untested here).

Key bind/rotate
- [ ] `[wire]` schemas: `keys/challenge` response, `keys/bind` body. Same local-schema deviation as above — defined in `app/routes/keys.ts`.
- [x] `[server]` `app/routes/keys.ts` *(new)*: `keys/challenge` (server nonce), `keys/bind` (verify sig over `accountId‖contentPubKey‖nonce`, first-bind vs rotate vs idempotent re-bind, 409 conflict, txn revoke-other-sessions on real rotation) (§6.2).
- [x] `[server]` helpers: `consumeNonce`, `verifyStepUp`, `hasOtherHealthySessions`. **Resolved (continuation pass):** `verifyStepUp` is now a real implementation — a discriminated `stepUpProof` (`{kind:"password", password}` verified via `auth/password.ts`'s `verifyPassword` against the account's own `auth_identities` password hash, or `{kind:"oauth", provider, oauthProof}` re-verified via the injectable `OAuthVerifier` and matched against the account's own `(kind, subject)` identity row). `buildKeysRoutes` now takes an injectable `oauthVerifier` (mirrors `buildOAuthRoutes`'s own DI), wired from `server.ts`. Key rotation is reachable and fenced: wrong step-up → 401 (no rotation); another healthy session online → 409 (interlock); correct step-up + no other sessions → 200, epoch bumped, every OTHER session revoked.
- [x] `[server]` `keys.test.ts`: replayed nonce rejected; invalid signature rejected; 409 on key-owned-by-another; 409 on an implicit (no `rotate` flag) rotation attempt; first-bind sets keyEpoch 0→1; **+4 new tests (continuation pass):** rotation with a correct step-up password succeeds and bumps keyEpoch; rotation with a wrong step-up password fails closed (401, keyEpoch unchanged); rotation is fenced with 409 while another device session is healthy; a successful rotation revokes every OTHER session but leaves the rotating session itself alive. 10/10 passing.

Pairing → sessions (E2E-sealed refresh token)
- [x] `[wire]`/`[crypto]`: bump pairing sealed-payload to `[0x01|masterSecret|refreshToken]`; version-tolerant decode. **Resolved (continuation pass):** the payload version bumped from `0x00` (bare `[version|masterSecret]`) to `0x01` (`[version|masterSecret|refreshToken]`) — `worker-handler.ts`'s `sealForPeer` mints it, `cli/src/auth/pair.ts` unseals it. No v0 emitter remains anywhere in the codebase (the approver always seals v1 now), so there's nothing left to tolerate-decode; a stray v0 box would only come from an already-expired (15-minute TTL) pairing attempt.
- [x] `[server]` `app/api/pair.ts`: `/approve` mints session server-side (uses `issueSession`), returns refresh token to approver to seal, store **hash** in `device_sessions` + opaque blob in `pairRequests.response`; **drop `pairRequests.token`**; delete row single-use on authorized pickup (§6.3). **Resolved (continuation pass):** split into two authenticated routes — `POST /v1/auth/pair/mint` mints the new device's session server-side and hands its refresh token straight back to the approving browser (never persisted to `pairRequests` at all), then `POST /v1/auth/pair/approve` stores only the caller-sealed `response` box. `pairRequests.token`/`pairRequests.refreshToken` columns **dropped** (`drizzle/0004_elite_blade.sql`) — the row now has only `response` (bytea). `POST /v1/auth/pair`'s poll handler deletes the row atomically the moment a poller reads back an authorized `response` (single-use pickup) — a second poll for the same `ephPub` afterward starts a brand-new `pending` attempt rather than ever re-serving the sealed box.
- [x] `[server]` `pair.test.ts`: updated so the approve route's bearer token belongs to a real `accounts` row — rewritten for the new mint/approve split and single-use pickup: 401/404/410 on `/mint`; mint doesn't touch the pending row; approve+poll round-trips the sealed box with no plaintext `token` field and only once (second poll → `pending`, a fresh attempt); first-approval-wins unchanged. 17/17 passing (real Postgres integration suite).
- [x] **Gate:** `pnpm --filter @falcon/server build/typecheck/test` green. **Acceptance:** password/OAuth login and key-bind (first-bind AND fenced rotation) work over HTTP end-to-end; pairing hands a device a real session with no plaintext refresh token ever touching Postgres or the unauthenticated poll route.

### Phase 3 — PIN crypto module (parallelizable with P1/P2)
- [x] `[crypto]` `pin.ts` (node) + `pin.web.ts` (browser): `wrapWithPin`/`unwrapWithPin` — argon2id KDF (identical params both platforms), raw-bytes AES-256-GCM, fresh 12-byte nonce, `null` on wrong PIN (§6.1). **Deviation:** signatures are `Promise`-returning (async), not sync as the plan's illustrative snippet showed — argon2id at these params is CPU-bound (~100-300ms) and both the node (`@node-rs/argon2` `hashRaw`) and browser (libsodium WASM `crypto_pwhash`) calls are naturally promise-based; forcing sync would block the event loop / UI thread. Noted in `pin.ts`'s docblock.
- [x] `[crypto]` `index.ts`/`index.web.ts`: export `wrapWithPin`, `unwrapWithPin`, `PinWrapped` (+ `pinReady` on the web entry point, mirroring the existing `ready` export pattern for libsodium init).
- [x] `[crypto]` `pin.test.ts`: round-trip; wrong-PIN→null; nonce uniqueness; **cross-platform argon2id vector parity** (node blob unwraps on web params & vice versa). All 8 tests pass (`pnpm --filter @falcon/crypto test`).
- [x] **Gate + Acceptance:** module usable from both node and web builds; parity vector passes. `pnpm --filter @falcon/crypto build && typecheck && test` all green.

### Phase 4 — Web migration (PIN, silent refresh, remove recovery/challenge); then delete legacy `/v1/auth`
**Overall status (continuation pass): done.** PIN key custody, the crypto-layer
rewrite, the legacy-route/recovery-code deletions, and `apiSocket.ts`'s live renew are
all implemented and tested — see the item-by-item notes below.

Crypto worker & storage
- [x] `[web]` `crypto/key-storage.ts`: stores a `StoredKeyRecord{wrapped: PinWrapped, signPubKey, contentPubKey}` — the master secret is never persisted raw; the two public identity keys sit alongside it in the clear so `getIdentity()` answers "known device?" without an unlock.
- [x] `[web]` `crypto/{worker-handler,client,protocol}.ts`: rewritten around `init(masterSecret, pin)` (wrap+derive+save) and `unlock(pin)` (load+unwrap+derive) exactly per the plan's illustrative pair — replaces the old auto-loading `ensureStartupLoaded()`. Every key-dependent op now distinguishes `"locked"` (something's stored, not yet unlocked) from `"not-initialized"` (nothing stored). `getIdentity()` still needs no unlock. `bindKeysProof` (added last pass) unchanged. `sealForPeer` now also takes the session's `refreshToken` (see Phase 2 note above) and requires the worker to be unlocked (keeps the raw `masterSecret` in worker memory, not just the derived tree, specifically so pairing can seal it verbatim).
- [x] `[web]` PIN UI: `components/auth/pin-setup-form.tsx` (set + confirm, min 6 chars) and `pin-unlock-form.tsx` (enter + "Forgot your PIN?" hook) — reused across signup, OAuth callback, and the reload-unlock gate. `lib/use-crypto-bridge.ts` was rebuilt as a refcounted **shared singleton** (was one-Worker-per-mount) — necessary because many independent feature hooks each called `useCryptoBridge()` on their own; without sharing, unlocking one would leave every other mounted feature's own worker instance still locked, forcing a PIN re-prompt per feature. `lib/use-unlocked-crypto-bridge.ts` wraps it with the `loading|no-identity|needs-unlock|ready` state machine `RequireAuth`/`password/page.tsx`/`pair/page.tsx` all consume. A fresh page load always starts locked (fresh worker singleton); unlocking once keeps every later-mounted consumer unlocked for the rest of that page load (no re-prompt across client-side navigation) — this is the concrete "reload requires PIN, then stays authenticated" behavior, verified live (see final report).

Identity & refresh
- [x] `[web]` `lib/api.ts`: `passwordRegister`/`passwordLogin`/`refreshSession`/`keysChallenge`/`keysBind` (now `rotate`/`stepUpProof`-aware)/`listDeviceSessions`/`revokeSession`/`revokeOtherSessions`/`mintPairSession` (new, §6.3). The legacy `signIn` (challenge) wrapper is **removed** (see Deletions).
- [x] `[web]` `lib/session.ts`: **rewritten (security-review remediation pass, finding F1 — see §13).** The refresh token no longer lives in `localStorage` at all — it's PIN-wrapped and persisted in IndexedDB alongside the master secret (`crypto/key-storage.ts`'s `StoredKeyRecord.wrappedRefreshToken`), recovered into the crypto worker's own memory on `unlock`, and never crosses back to the main thread. The access token is now a plain in-memory module variable (`inMemoryAccessToken`), not `localStorage` either — wiped on reload by design (cheap to re-mint, 15m TTL). `silentRefresh()` now calls the worker's own `refreshSession()` (via `use-crypto-bridge.ts`'s new `getSharedCryptoBridge()` peek accessor) instead of an HTTP call from `lib/api.ts` — the worker performs the `/v1/auth/refresh` fetch itself so the raw refresh token never crosses the postMessage boundary in either direction. Still no cross-tab `navigator.locks` serialization (the server's grace window absorbs a concurrent double-refresh regardless, unchanged from before).
- [x] `[web]` password sign-in/sign-up page (`app/(public)/password/page.tsx`) — now a real multi-step flow: sign-up collects email+password+PIN in one screen and calls `completePasswordSignUp` (register → `bridge.init(masterSecret, pin)` → `keys/bind`); sign-in calls `completePasswordSignIn` then walks a post-login step machine (`needs-unlock` → `PinUnlockForm`, or `needs-rotate`/"Forgot your PIN?" → step-up password → new PIN → `rotateKeyEpoch`, handling the interlock's 409/401 responses inline).
- [x] `[web]` `lib/complete-oauth-sign-in.ts` + `components/auth/oauth-callback-page.tsx`: rewritten to mirror the password flow — a new identity collects a PIN (`set-pin` step) before `bridge.init`; a returning, not-yet-unlocked identity gets a `PinUnlockForm` step before redirecting on. **Bonus fix surfaced while wiring this:** `POST /v1/auth/register` (OAuth) never returned a `refreshToken` at all (a pre-existing gap predating this pass, invisible before because nothing exercised OAuth's session past its 1h/15m access token) — `oauth.ts`'s response schema and handler now mint and return one via `issueSession`, same as the password routes.
- [x] `[web]` `features/auth/require-auth.tsx`: silent-refresh unchanged from the prior pass; **now additionally gates on crypto-worker-unlocked** (`useUnlockedCryptoBridge`) — `no-identity` renders a "pair or rotate" message, `needs-unlock` renders `PinUnlockForm`, only `ready` renders `children`.
- [x] `[web]` `sync/apiSocket.ts`: **done (continuation pass).** Proactive in-band `renew-token` ~10 minutes after each (re)connect (mirrors the CLI's `machineClient.ts`/`sessionClient.ts` cadence, comfortably inside the 15-minute TTL), re-armed on success; a single `forceRefresh()`-then-reconnect on an auth-shaped `connect_error` via `session.ts`'s `silentRefresh()`, instead of just tearing down. Covered by new `apiSocket.test.ts` cases (renew-token timer, connect_error triggers exactly one silent-refresh-then-reconnect, no infinite loop on a dead refresh token).

Deletions
- [x] `[web]` deleted `lib/complete-challenge-sign-in.ts`, `lib/restore-recovery-code.ts` (+`.test.ts`), `app/(public)/signin/restore-handler.ts` (+`.test.ts`), `components/auth/recovery-code-card.tsx`, `recovery-code-input.tsx` (+`.test.tsx`), `features/settings/components/RecoverySection.tsx` (+ its entry in `sections.tsx`), and `signin/page.tsx`'s recovery-restore + auto-challenge-sign-in branches — `signin/page.tsx` is now OAuth buttons + a link to `/password/`, nothing that reads local key material before a login click.
- [x] `[server]` **deleted `app/routes/auth.ts`** (`POST /v1/auth`) + `auth.test.ts` + its registration in `server.ts` — done only after confirming (grep) the web no longer called it (`signIn()` removed from `lib/api.ts` in the same pass).
- [x] `[crypto]` removed `encodeRecoveryCode`/`decodeRecoveryCode` exports (`recovery.ts` deleted, plus `recovery.test.ts` and the recovery-code `describe` block in `edge-cases.test.ts`).

New-device chooser
- [x] `[web]` "new device, no local key" screen: folded into the PIN-unlock state machine rather than a separate screen — `RequireAuth`'s `no-identity` branch and `password/page.tsx`'s `needs-rotate` step both cover it (point at pairing or the rotate-epoch flow).
- [x] `[web]` tests: `worker-handler.test.ts`/`client.test.ts` rewritten for `init(secret,pin)`/`unlock(pin)`/locked-vs-not-initialized/sealForPeer+refreshToken (33 tests); `complete-password-sign-in.test.ts` (new, 6 tests: signup binds+unlocks, identity reuse, sign-in, rotate success/wrong-password/409-interlock); `signin/page.test.ts` rewritten (recovery/challenge modules gone, OAuth+password-link present); `apiSocket.test.ts` extended for renew-token + connect_error refresh. "Recovery UI gone" is asserted directly (source-text check that the deleted modules are never imported).
- [x] **Gate:** `pnpm --filter @falcon/web build/typecheck/test` green (real Next.js static-export build incl. the new `/password` route; 147 files / 1090 tests). **Acceptance:** legacy route IS gone; recovery code IS gone; PIN set/unlock/rotate-epoch UI exists and is wired end-to-end. See final report for the live browser verification (PIN set at signup, reload requires unlock and then stays authenticated).

### Phase 5 — CLI/daemon migration (token provider, re-auth, custody)
**Overall status (continuation pass): done**, including the PIN/device-key discriminated
custody union deferred by the previous pass.
- [x] `[cli]` `auth/credentials.ts`: **rewritten (continuation pass)** to the plan's discriminated `keyMaterial: {mode:"pin", wrapped: PinWrapped} | {mode:"device", wrapped: DeviceWrapped} | {mode:"plaintext-fallback", bundle}` union, zod-validated (a legacy flat `masterSecretOrContentBundle` file now fails `readCredentials` cleanly, treated as "not logged in" rather than crashing). Round-trip tests for all three modes.
- [x] `[cli]` `auth/tokenProvider.ts`: `getAccessToken` (cache to ~1m pre-exp), `forceRefresh`, persists rotated refresh token via injected `onRotate`, dead-refresh → logs "run `falcon auth login`" and stops retrying (`isDead`). **Resolved (security-review remediation pass, reviewer nit — see §13):** the refresh response is now validated with a Zod schema (`RefreshResponseSchema.safeParse`) instead of a bare `as RefreshResponse` type assertion over untyped `res.json()` — a malformed body now resolves `null` (logged, not thrown), matching the "parse-don't-trust" convention `auth/pair.ts`/`auth/credentials.ts` already use elsewhere in this package. 6 unit tests (was 5 — added the malformed-response case).
- [x] `[cli]` `auth/pin.ts` *(new, continuation pass)*: `promptAndWrapWithPin`/`promptAndUnwrapWithPin` — `node:readline/promises` prompt (mirrors `shim/onboardingPrompt.ts`'s own pattern), re-prompts on a too-short PIN or confirmation mismatch, bounded 3-attempt unlock retry. **Known gap:** plain visible input, no raw-mode masked echo (documented in the module's own doc comment — cut for this pass).
- [x] `[cli]` `auth/deviceKey.ts` *(new, continuation pass)*: `wrapWithDeviceKey`/`unwrapWithDeviceKey` — AES-256-GCM under a random device key that itself lives in the macOS Keychain (`security` CLI, same tool `provider/claudeAuth.ts` already shells out to), falling back to a documented plaintext 0600 file (`~/.falcon/device.key`) when the Keychain is unavailable (non-macOS, or `security` fails) — never both at once, so a key wrapped one way is always found the same way later. Injectable `readKeychainKey`/`writeKeychainKey` deps so tests never touch the real host Keychain.
- [x] `[cli]` `auth/keyMaterial.ts` *(new, continuation pass)*: `wrapNewKeyMaterial` (PIN-wraps at an interactive TTY, else device-wraps — the daemon-friendly default) and `resolveKeyMaterial` (unwraps any of the three modes; `"pin"` without `pinDeps` resolves `null` rather than hanging waiting on input nobody can provide).
- [x] `[cli]` `auth/login.ts`: writes the new discriminated `keyMaterial` shape after pairing — PIN-wrapped when `process.stdin.isTTY`, device-wrapped (daemon-style default) otherwise.
- [x] `[cli]` `daemon/machineIntegration.ts`: unwraps via `resolveKeyMaterial` (no `pinDeps` — the daemon never runs interactively) instead of decoding `masterSecretOrContentBundle` directly; a PIN-protected credential with no one to prompt now logs a clear "skipping machine client" warning instead of silently misinterpreting the wrapped blob as raw bytes.
- [x] `[cli]` `daemon/machineClient.ts`: unchanged from the prior pass.
- [x] `[cli]` threaded through: `daemon/blobClient.ts`, `daemon/unmanagedSessionClient.ts`, `commands/{start,startCodex,sessionsList}.ts`. **Resolved (continuation pass):** `session/sessionClient.ts` now also takes a live `TokenProvider` (was a static `token: string`) — async `auth` callback (mirrors `machineClient.ts`), proactive `renew-token` every 10 minutes, `forceRefresh` on an auth-shaped `connect_error`. `commands/start.ts`/`startCodex.ts` build one `TokenProvider` per invocation (`auth/resolveAccessToken.ts`'s new `createTokenProviderForCredentials`) and hand the SAME provider to the session-scoped WS client, so `falcon claude`/`falcon codex`'s live socket now survives the access-token TTL the same way the daemon's connection does. **Still not threaded** (unchanged, genuinely separate systems): `daemon/githubChecks.ts`/`commands/github.ts` (GitHub PAT auth) and the outbox/status-report/session-metadata one-shot HTTP calls within a single `falcon claude` invocation (documented, narrower remaining gap — short bursts around session start/exit, not a multi-hour-lived connection).
- [x] `[cli]` tests: tokenProvider (5); daemon re-auth `forceRefresh` (1); `commands.machineWiring.integration.test.ts` (real server); **+ (continuation pass)** `deviceKey.test.ts` (6, Keychain-path + fallback-file-path, corrupt-blob/wrong-version → null), `pin.test.ts` (6, wrap/confirm/retry/unwrap/wrong-PIN-retry-then-give-up), `credentials.test.ts` (11, all three modes + legacy-shape rejection), `sessionClient.test.ts` rewritten for the live `TokenProvider` (12, incl. new renew-token + connect_error-forces-refresh cases).
- [x] **Gate:** `pnpm --filter falcon build/typecheck/test` green (162 files, 1900 tests). **Acceptance:** `falcon auth login` PIN-wraps (TTY) or device-wraps (headless) the master secret; the daemon self-heals its access token and survives past the access-token boundary (real-server integration test); `falcon claude`'s interactive session socket now does too (live `TokenProvider`, unit-tested).

### Phase 6 — Flip to short TTL + live WS lifecycle + admin UI
- [x] `[server]` `auth/tokens.ts`: `ACCESS_TOKEN_TTL_SECONDS = 15m`.
- [x] `[server]` `app/socket.ts`: connect-time revocation check (`revokedAt`/`expiresAt`); `renew-token` handler (re-validate, re-arm timer, no drop); expiry disconnect timer; `disconnectSession` (§4.5).
- [x] `[server]` `app/events/eventRouter.ts`: `connectionsForAccount` accessor + `disconnectSession` helper.
- [x] `[server]` `app/routes/sessionsAdmin.ts` *(new)*: list sessions, revoke one, revoke-others → disconnect live sockets. **Deviation:** no `[wire]` schemas — same local-schema convention as Phases 1-2 (defined in the route file itself).
- [x] `[web]` proactive `renew-token` ~10m post-connect (same fixed-interval cadence as the CLI's `armRenewTimer`, comfortably inside the 15m TTL — resolved, continuation pass): `sync/apiSocket.ts` takes an injectable `TokenRenewSource` (mirrors `SocketFactory`/`VisibilitySource`'s own testable-dependency pattern); `sync/index.ts` wires the real one through `lib/session.ts`'s `silentRefresh()`. A single silent-refresh attempt on an auth-shaped `connect_error` updates the socket's presented token in place (no manual reconnect — `getAuth` reads the current token fresh on every automatic retry) instead of tearing down immediately; only a definitively-dead refresh token still falls through to the original teardown+`authError` behavior. **Resolved (security-review remediation pass, finding F2 — see §13):** the settings device-sessions list + "log out other devices" UI is now built — `features/settings/components/DevicesSection.tsx`, wired into the settings dialog as a new "Devices" section, calling the real `listDeviceSessions`/`revokeSession`/`revokeOtherSessions` routes.
- [x] `[cli]` confirms proactive `renew-token` emit works against a real server: `machineClient.ts`/`sessionClient.ts` both emit it every 10 minutes on a live socket (unit-tested), and `socket.test.ts`'s revocation tests prove the server-side handler actually re-arms/rejects correctly. Not verified against a real 15-minute wall-clock wait in this pass (impractical for a test run) — verified via the mechanism's unit/integration coverage instead.
- [x] tests: revoked session dropped **immediately** on live WS (`sessionsAdmin.test.ts`); `renew-token` keeps socket up / rejects a revoked renewal (`socket.test.ts`); revoke-others (`sessionsAdmin.test.ts`); **+ (continuation pass)** `apiSocket.test.ts`'s new renew-token/connect_error-recovery cases (6: proactive emit + re-arm, no-op with no renew source wired, timer stopped on disconnect, silent recovery on a stale-token connect_error, fall-through to teardown on a dead refresh token, never renews for a non-auth connect_error).
- [x] **Gate:** `pnpm --filter @falcon/server build/typecheck/test`, `pnpm --filter falcon build/typecheck/test`, and `pnpm --filter @falcon/web build/typecheck/test` all green after the same TTL flip. **Acceptance:** 15m tokens; revocation immediate on WS; ≤15m on HTTP (by construction); a live web socket now also survives the access-token boundary via its own proactive renew (verified live in the browser — see final report), not just the CLI's daemon connection. Web-side sessions-admin UI is now built (finding F2, §13).

### Phase 7 — Cloud sandbox (deferred; design lands, build later)
**Deliberately skipped in this pass** — per explicit instruction, Phase 7 is design-only/deferred and its build was not started. The design in §7 above stands as-is; no code changes.
- [ ] `[server]` accept `clientKind:"cloud-sandbox"` device sessions tied to a server-provisioned `machines` row.
- [ ] `[server]` per-session key custody for sandbox sessions (server-held or sandbox-wrapped DEK); flag via `workspaces.syncEnabled`/`sandboxConfig`.
- [ ] provisioning + revoke flow for a sandbox device session.
- [ ] docs: mark local = E2E, cloud = server-trusted, per-session.

### Cross-cutting / docs
- [x] Update `docs/encryption.md`: PIN posture, daemon custody limits, key-epoch rotation semantics, refresh lifetime policy — new "§5 Identity vs. key custody" section added.
- [ ] Update `docs/protocol.md` / `docs/falcon-system-design.md` §5.2/§6.2 — **still not done** (out of this pass's explicit 6-item scope); the legacy `/v1/auth` challenge route IS now removed (see Phase 4 above), so these docs are now more stale than before, not less — a real follow-up.
- [ ] Update `docs/uninstall.md` — **not done**; `~/.falcon/access.key`'s shape changed again (`keyMaterial` discriminated union, plus the new `~/.falcon/device.key` fallback file this pass's `deviceKey.ts` can create) but the location/`rm -rf ~/.falcon` guidance still covers all of it, so uninstall's actual instructions remain correct, just not narrated.
- [ ] Flip `docs/known-issues.md` #4 → Resolved — **could not do**: this worktree's `docs/known-issues.md` has no issue #4 entry at all — unchanged from the prior pass's finding.
- [ ] Security re-review of v2 — **not done** (would need a second reviewer/pass beyond this implementation session).

## Testing evidence

### Automated (this pass)
Root-level `pnpm build`/`pnpm typecheck` (turbo, all 6 packages incl. `@falcon/wire`/`@falcon/e2e`)
both fully green. Per-package: `pnpm --filter @falcon/crypto build/typecheck/test` (9 files/71
tests), `pnpm --filter @falcon/server build/typecheck/test` (46 files/357 tests, real Postgres —
incl. the rewritten `pair.test.ts`'s 17 tests and `keys.test.ts`'s 10 tests, both exercising this
pass's new behavior against a real database), `pnpm --filter falcon build/typecheck/test` (162
files/1900 tests, incl. the real-socket `sessionClient.integration.test.ts` and the real-server
`commands.machineWiring.integration.test.ts`), `pnpm --filter @falcon/web build/typecheck/test`
(real Next.js static-export build incl. the new `/password` route, 147 files/1096 tests), `pnpm
--filter @falcon/e2e build/typecheck/test` (20-step conformance harness, real Postgres+server —
`e2e/src/testStack.ts` still wrote the OLD flat `masterSecretOrContentBundle` credential shape,
missed by the Phase 5 CLI rewrite since it lives outside `packages/`; caught only by the
root-level `pnpm build`, fixed to use the new `keyMaterial` shape via
`plaintextFallbackKeyMaterial`). Repo-wide `pnpm lint`: 8 pre-existing errors / 124 warnings, all
in files untouched this session (confirmed by cross-referencing `git status`) — zero new
errors/warnings in any file this pass touched.

### Manual (tmux + Chrome MCP, against a real local Postgres + real server + real web dev server on
non-default ports 4102/4103 — this session's own processes only, pid/cwd-verified before every
kill per the explicit process-hygiene instruction)

- **PIN set at signup, reload requires unlock, stays authenticated**: registered a fresh
  email+password account with a PIN in the browser → real `masterSecret` generated,
  PIN-wrapped (`bridge.init`), `keys/bind` first-bind succeeded (verified `accounts.key_epoch`
  0→1 in Postgres) → landed authenticated with no recovery-code step. A full browser reload
  (`navigate`, not SPA nav) correctly re-prompted for the PIN (`RequireAuth`'s `needs-unlock`
  gate); entering it unlocked and landed back on the same account, and further **client-side**
  navigation (Sessions → New session) did NOT re-prompt — confirming the shared crypto-bridge
  singleton's debounced-teardown grace window (a bug found and fixed live, see below) actually
  delivers "stays authenticated across navigation, but reload always needs the PIN again."
- **Lost-PIN → rotate-epoch, including the "other devices online" interlock**: from `/password/`'s
  sign-in path, clicked "Forgot your PIN?" → re-entered the account password as the step-up proof
  → attempted rotation while a second device session was still healthy → got a **live 409**
  ("Another device is still signed in — pair this browser from that device instead of rotating
  keys blind"), and confirmed in Postgres that `key_epoch` was untouched by the blocked attempt.
  Revoked the other session via the real `revoke-others` API, retried, and the rotation succeeded
  (`key_epoch` 1→2, verified in Postgres) with no error — the exact fenced-then-succeeds sequence
  Item 4 was meant to guarantee.
- **Sealed pairing, no plaintext token at rest**: ran the real built CLI (`falcon auth login`)
  against the test server from an isolated `FALCON_HOME_DIR`, opened the printed pairing URL in
  the already-unlocked browser, and approved it. The CLI printed "Logged in to Falcon." and
  persisted `~/.falcon/access.key` with `keyMaterial.mode: "device"` (OS-Keychain-style wrap,
  correct for a non-interactive/no-TTY login) and a real (locally-plaintext, as designed —
  the point was never relaying it over the wire unsealed) refresh token. Confirmed directly in
  Postgres: `pair_requests` has no `token`/`refresh_token` columns at all (schema-level
  impossibility, not just runtime discipline); the specific row for this `ephPub` was **deleted**
  after the CLI's single successful pickup (single-use, verified by re-querying for it — zero
  rows); a real `cli-daemon` `device_sessions` row was created and stayed healthy.
- **Live web renew wiring reaches a real socket**: confirmed (via server logs) a real
  `socket connected: account=… clientType=user-scoped` line once the env-var bug below was fixed —
  `sync/apiSocket.ts`'s proactive `renew-token` timer and connect_error recovery path are unit-
  tested (6 new cases) rather than wall-clock-verified against the real 15-minute TTL in this pass
  (impractical for an interactive session), same documented tradeoff the CLI side already used.

### Bugs found and fixed *during* this live verification pass (all pre-existing or newly introduced
this session, none left in place once found)
1. **`sync/socket-factory.ts` read a different env var than `lib/config.ts`** (`NEXT_PUBLIC_FALCON_API_URL`
   vs. `NEXT_PUBLIC_API_URL`) — a pre-existing split-brain config bug (present before this pass) that
   silently pointed the WS client at `localhost:3005` (nothing listening) while every HTTP call
   worked fine against the real server, manifesting as a permanent "Reconnecting to Falcon…" banner
   with zero console errors. Fixed by having `socket-factory.ts` import `API_URL` from
   `lib/config.ts` directly — one source of truth for "where's the server" now, not two.
2. **`worker-handler.ts`'s `sealForPeer` decoded `ephPub` with the wrong base64 variant** —
   `app/(public)/pair/page.tsx` always re-encodes the URL fragment's ephemeral key to *plain*
   base64 before calling `sealForPeer` (documented in that file's own comment, matching how the
   server looks up the pending request), but the worker decoded it as base64url — silently
   corrupting any `ephPub` whose plain-base64 form contains `+`/`/`. Pre-existing (not introduced
   this pass), caught because a real pairing attempt's ephemeral key happened to need a `+`. Fixed
   by decoding with the (default) plain `base64` variant, matching the actual caller.
3. **`app/(public)/pair/page.tsx` never gated on the crypto worker being unlocked** — introduced
   this pass, as a direct consequence of PIN-wrapping: `sealForPeer` now requires the worker
   unlocked (it needs the raw `masterSecret` in memory), but the pair page only ever checked
   `getIdentity()` (which never needs an unlock) before offering "Approve". A pairing link opened
   as the first thing in a fresh tab hit this every time. Fixed by gating the page on
   `useUnlockedCryptoBridge()`, the same hook `RequireAuth`/`password/page.tsx` use.
4. **`lib/use-crypto-bridge.ts`'s shared singleton tore down too eagerly across client-side
   navigation** — introduced this pass, in the very refactor meant to fix the opposite problem: a
   React route change unmounts the old page's tree and mounts the new one as two separate commits,
   so the shared bridge's refcount can genuinely (if briefly) hit 0 between them even within the
   same page load — e.g. `password/page.tsx` redirecting to `/` right after unlocking. Fixed with a
   debounced (2s grace window) teardown instead of an immediate one on refcount-zero.

All four were caught by the live browser+CLI+Postgres verification itself, not by the automated
test suites (which mock the pieces these bugs lived in the seams between) — this is exactly the
category of gap the coordinator's explicit "re-test end-to-end" instruction was for.

## 13. Security review remediation (F1/F2/F3 + nits)

An independent security review of the implementation above passed the crypto/auth machinery as
real, with every suite green, but flagged three findings to close before merge, plus two optional
nits. All fixed in this same pass, in the same worktree.

### F1 — refresh token out of `localStorage`

**Problem:** `lib/session.ts` stored both the access token and the 60-day refresh token in
`localStorage` — fully XSS-readable, and exactly what §6.4 said not to do. An XSS that can read
`localStorage` was getting a long-lived, full-account credential, which defeated the point of the
15-minute access-token hardening (Phase 6): the access token being short-lived doesn't help if the
thing that mints new ones sits in the clear right next to it.

**Chosen fix — PIN-wrapped refresh token in the crypto worker/IndexedDB (the plan's preferred
option), not the httpOnly-cookie alternative.** Reasoning: the crypto worker already holds the
trust boundary this needs (masterSecret in worker memory only, PIN-wrapped at rest, main thread
never sees raw key material — Phase 3/4 above) — extending that exact boundary to the refresh
token reuses infrastructure instead of adding a second, differently-shaped one (cookies + CSRF
double-submit) alongside it. It also composes for free with pairing, which already seals the
refresh token to a peer through the same worker (`sealForPeer`, Phase 2).

What changed:
- `crypto/key-storage.ts`: `StoredKeyRecord` gained an optional `wrappedRefreshToken`.
- `crypto/protocol.ts`: `init` now also takes a `refreshToken`; two new request types,
  `setRefreshToken` and `refreshSession`.
- `crypto/worker-handler.ts`: `init`/`unlock` wrap/unwrap the refresh token the same way as the
  master secret (cached alongside a cached `pin` so a later rotation can re-wrap without
  re-prompting). The worker now makes the `POST /v1/auth/refresh` HTTP call **itself**, from
  inside the Worker — not just storing the refresh token, but never handing the raw token back to
  the main thread in either direction. Only the freshly-minted (short-lived) access token crosses
  back out. `refreshSession` never throws — no refresh token / a dead-refresh-token /a network
  failure all resolve `null`, mirroring `unlock`'s own "resolve false, don't reject" convention.
- `crypto/client.ts`: `init(masterSecret, pin, refreshToken)` (3rd arg), + `setRefreshToken`/
  `refreshSession` on `CryptoBridgeClient`.
- `lib/use-crypto-bridge.ts`: new `getSharedCryptoBridge()` — a non-hook "peek" accessor (returns
  the live shared bridge only if already unlocked, without touching its refcount) for code outside
  the component tree, specifically `lib/session.ts`.
- `lib/session.ts`: **rewritten.** No more `localStorage` at all. The access token is a plain
  in-memory module variable; `silentRefresh()` calls `getSharedCryptoBridge()?.refreshSession()`.
- `lib/api.ts`: removed the old HTTP `refreshSession()` wrapper — the call moved inside the worker.
- `features/auth/require-auth.tsx`: the crypto-unlock gate now runs *before* the silent-refresh
  effect (there's no refresh token to recover from until the worker is unlocked — no more two
  independent state machines racing each other).
- `lib/complete-password-sign-in.ts`/`complete-oauth-sign-in.ts`: sign-up persists the refresh
  token directly via the widened `bridge.init(...)`; sign-in/OAuth-existing-identity instead
  return it to the caller, since the worker isn't necessarily unlocked yet at that point —
  `app/(public)/password/page.tsx` and `components/auth/oauth-callback-page.tsx` hold it in
  transient component state (`pendingRefreshToken`, never written to `localStorage`) just long
  enough to call `bridge.setRefreshToken(...)` once their own post-login unlock step confirms the
  worker is unlocked.
- `lib/logout.ts`: needed no change — `worker-handler.ts`'s `clear()` case already wipes the whole
  persisted record (now including `wrappedRefreshToken`) and resets all in-memory state (now
  including `refreshToken`/`pin`).
- Tests: `crypto/__tests__/client.test.ts`, `crypto/__tests__/worker-handler.test.ts`,
  `lib/__tests__/blobs.test.ts`, `lib/complete-password-sign-in.test.ts`,
  `lib/use-session-metadata-write.test.ts` updated for the widened signatures/new required fake-
  bridge methods. `lib/__tests__/session.test.ts` rewritten — the old suite stubbed
  `window.localStorage` (accurate for the old design); now drives `setToken`/`getToken`/
  `clearToken` directly and adds coverage for `silentRefresh`'s three outcomes (no bridge → false,
  unchanged token; bridge with nothing to refresh → false, token cleared; bridge mints a fresh
  token → true). The now-redundant top-level `lib/session.test.ts` (a smaller, older duplicate
  covering only `getAccountId`) was folded into the same file and removed.

### F2 — web session-revocation UI

**Problem:** `GET /v1/auth/sessions`, `/revoke`, `/revoke-others` (`sessionsAdmin.ts`) existed,
worked, and were tested server-side, but nothing in the web app called them.

**Fix:** `features/settings/components/DevicesSection.tsx` (new), wired into
`features/settings/sections.tsx` as a new "Devices" section (settings dialog, alongside
Notifications/Machines/etc.). Lists the account's active device sessions (client kind, label,
last-used, a "This device" badge on the caller's own session); a per-row "Log out" button revokes
that specific session (`revokeSession`); the current-device row's button reads "Log out this
device" and, after the server-side revoke, also runs the same local teardown `nav-user.tsx`'s
sign-out button does (`lib/logout.ts`) before redirecting to sign-in, since that session is now
dead server-side regardless; a top-level "Log out all other devices" button calls
`revokeOtherSessions`. No new component test was added — matching the existing, established
precedent for every sibling settings section (`NotificationsSection`, `AgentSection`, etc., none of
which have component tests either, since this package has no jsdom/interactive-rendering test
environment); verified instead via live browser testing (see below).

### F3 — per-identity login lockout

**Problem:** `password.ts`'s login route had only Fastify's per-route, per-IP rate limit — an
attacker rotating source IPs faces no additional friction brute-forcing one known email.

**Fix:** `authIdentities` gained two columns (`drizzle/0005_broad_wong.sql`): `failedLoginCount`
(int, default 0) and `lockedUntil` (nullable timestamp). Login now: rejects immediately (generic
401) if `lockedUntil` is still in the future, *before* even checking the password — a locked
identity gets turned away the same way a wrong password does, no distinguishing response. A wrong
password atomically increments `failedLoginCount`; at `LOCKOUT_THRESHOLD` (5) consecutive failures
it sets `lockedUntil` to an exponentially growing backoff (`LOCKOUT_BASE_MS` 30s, doubling per
extra failure past the threshold, capped at `LOCKOUT_MAX_MS` 15 minutes) — a real owner's
occasional mistyped password is barely felt, a sustained guesser is throttled hard. A correct
password clears both fields, regardless of what they were. `password.test.ts` gained an isolated
`describe` block with its own `app`/`db` (not sharing the main suite's instance, so its several
back-to-back login attempts don't collide with the shared instance's own per-route rate-limit
counter or its other tests' already-issued login calls): locks out after 5 wrong passwords,
confirms the correct password is *also* rejected with the byte-identical generic error while
locked, and confirms a different, never-failed identity's correct login leaves its own counter/lock
at zero.

### Nits (also fixed)

- `cli/src/auth/tokenProvider.ts`: `RefreshResponseSchema` (Zod) replaces the bare
  `as RefreshResponse` cast over `res.json()` — matches this package's own parse-don't-trust
  convention (`auth/pair.ts`, `auth/credentials.ts`). A malformed response now resolves `null`
  (logged as a warning), same non-throwing shape as every other `doRefresh` failure path. New test:
  a response missing `refreshToken` entirely resolves `null` without marking the provider dead
  (dead is reserved for a definitive 401, not a malformed-but-200 body).
- Phase 0's doc note (§12) claimed web would standardize on `NEXT_PUBLIC_FALCON_API_URL`; what
  actually shipped (and what bug #1 in the Phase 4 testing-evidence section above was about) is
  `lib/config.ts`'s `API_URL`, backed by `NEXT_PUBLIC_API_URL` — the note now says so, and
  `crypto/worker-handler.ts`'s new F1 `refreshSession` imports that same `API_URL`, not a third
  name.

### Testing evidence (this remediation pass)

**Automated:** `pnpm --filter @falcon/web build/typecheck/test` green (1099 tests — net +3 after
adding `silentRefresh`/lockout-adjacent coverage, the new "Session revoked" `connect_error` cases
in `apiSocket.test.ts`, and removing the now-redundant top-level `session.test.ts`).
`pnpm --filter @falcon/server build/typecheck/test` green (359 tests — the new isolated lockout
`describe` block's 2 tests replace what the F3 gap note used to document as untested).
`pnpm --filter falcon build/typecheck/test` green (1901 tests — `tokenProvider`'s new
malformed-response case). `pnpm --filter @falcon/crypto test` (71), `pnpm --filter @falcon/wire
test` (171), `pnpm --filter @falcon/e2e test` (1) all green, unaffected by this pass. Root `pnpm
build`/`pnpm typecheck` both green across all 6 packages. Root `pnpm test` (turbo, all packages in
parallel) hit transient hook/test timeouts in unrelated files (`blobs.test.ts`, `machines.test.ts`,
`oauth.test.ts`, `index.test.ts` — none touched this pass) from real Postgres-connection/CPU
contention running everything concurrently, exactly the kind of transient failure this repo's own
`pnpm lint` retry-once precedent exists for; every affected suite (and the full suite generally)
passes cleanly when run standalone per-package, confirmed above. `pnpm lint` (the root script) hit
what looks like an environment-local issue unrelated to the code — invoking the biome binary
directly (`node_modules/.bin/biome check .`, bypassing the `pnpm exec`/hook-rewritten invocation)
runs cleanly and reports the exact same 14 pre-existing errors / 124 pre-existing warnings / 1 info
as before this pass, none in any file this pass touched (confirmed by diffing the error-file list
against `git status`) — a real content-level lint failure would show up either way, so this is
recorded as a tooling quirk, not a code issue.

**Manual (tmux + Chrome MCP, email/password, non-default ports 4102/4103, same
pid/cwd-verified-before-kill process hygiene as the prior pass):**
- **F1 — no refresh token (or access token) in `localStorage`:** signed up a fresh email+password
  account with a PIN; `localStorage` was confirmed empty (`{}`) both immediately after signup and
  after a real browser reload; IndexedDB's `falcon-crypto-bridge` store was confirmed to hold a
  `wrappedRefreshToken` field alongside the wrapped master secret. A hard reload correctly
  re-prompted for the PIN (in-memory access token wiped, worker locked); entering it triggered
  `silentRefresh()` (via the worker's `refreshSession()`), landed back on the authenticated Sessions
  screen, and the server log showed a fresh `socket connected` line — confirming silent refresh and
  socket renew both still work end-to-end with no token ever touching `localStorage`.
- **F2 — Devices UI revokes a session, socket drops immediately:** opened Settings → Devices,
  confirmed it lists this account's real device sessions (client kind, "This device" badge, last-used
  relative time) via the real `GET /v1/auth/sessions`. Using a second signed-in tab to get two live
  device sessions, revoking a session from the Devices list correctly removed it from the list and
  set `revoked_at` in Postgres; revoking the CURRENT session via "Log out this device" immediately
  force-disconnected the live socket(s) for that session server-side (`socket disconnected` logged
  the instant the revoke request completed — verified against **two** simultaneous live sockets
  sharing that session, both dropped in the same instant) and ran the local sign-out teardown,
  landing back on `/signin/`.
- **F3 — login lockout:** attempted 5 consecutive wrong passwords against a real account — each
  got the generic "Invalid email or password" 401; Postgres confirmed `failed_login_count=5` and a
  `locked_until` `LOCKOUT_BASE_MS` (30s) in the future after the 5th. The account's own CORRECT
  password was then submitted while still locked and got the byte-identical generic error (no
  lock-vs-wrong-password oracle). After the lockout window passed, the correct password succeeded
  and Postgres confirmed `failed_login_count`/`locked_until` both reset to `0`/`null`.

**Bug found and fixed during this live verification pass:** while verifying F2's "revoked session's
socket drops immediately," the socket disconnected instantly server-side as expected (confirmed via
server logs) but the affected browser tab then got stuck indefinitely on a "Reconnecting to
Falcon…" banner instead of ever noticing its session was dead and redirecting to sign-in. Root
cause: `sync/apiSocket.ts`'s `handleConnectError` only treated a `connect_error` as auth-shaped
(worth a silent-refresh attempt, then teardown+`authError` on failure) when its message matched
`/authentication token/i` — the server's connect-time revocation check (`app/socket.ts`) rejects a
revoked session's handshake with `"Session revoked"` instead, which never matched. The CLI's own
`daemon/machineClient.ts`/`session/sessionClient.ts` already had the correct, wider regex
(`/authentication token|Session revoked/i`) — this was a real web/CLI inconsistency, not a
deliberate design difference. Fixed by widening the web-side regex to match; added two new
`apiSocket.test.ts` cases (the base "Session revoked" → `authError` case, and the renew-token
describe block's "triggers a silent-refresh attempt, falls through to teardown on failure" case)
and re-verified live: after the fix, the previously-stuck tab correctly redirected to `/signin/`
within a few seconds of its live socket being revoked.
