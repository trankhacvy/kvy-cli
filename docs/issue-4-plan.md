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
- **Env-var mismatch footgun:** CLI resolves `FALCON_BACKEND_URL` (`cli/src/auth/config.ts:17`); web uses `NEXT_PUBLIC_FALCON_API_URL` (`web/src/lib/config.ts`) and separately `NEXT_PUBLIC_API_URL`. Refresh tokens are **per-server** credentials, so mismatched origins now fail more confusingly (pairing pends forever; refresh 401s). Unify to one documented var and log the resolved server URL at startup on both clients.

## 10. Testing

- **crypto:** `pin.test.ts` — round-trip, wrong-PIN→null, **cross-platform argon2id vector parity** (now valid because both platforms use identical params), nonce uniqueness.
- **server:** refresh happy-path rotation; **stolen-token replay outside grace → family revoked**; multi-tab replay inside grace → tolerated (idempotent); revoked session rejected at WS connect **and disconnected live**; `renew-token` keeps a socket up across expiry; `keys/bind` rejects replayed nonce, rejects rotation without step-up/while devices online, returns 409 on key-owned-by-another; password register/login rate-limited + no enumeration; reset revokes all sessions; OAuth links only on verified email.
- **cli:** `tokenProvider` refresh+persist+rotate; daemon re-auth after forced 401; credentials new-shape round-trip for all three key-material modes; dead-refresh → clear "run falcon auth login" message.
- **web:** unlock (PIN→worker); silent refresh replaces redirect; new-device chooser; revoke-others; recovery-code UI is gone.

## 11. File-by-file change list

**server:** `db/schema.ts` (+`authIdentities`,`deviceSessions`,`keyBindNonces`; `accounts` nullable signPublicKey + `keyEpoch`, **drop `oauthProvider`/`oauthSubject`**; `keyEpoch` on `machines`/`sessions`/`workspaces`; **drop `pairRequests.token`**) · `auth/tokens.ts` (claims, `mintAccessToken`, reject missing `sid`/`ct`) · `auth/refresh.ts` *(new)* · `auth/password.ts` *(new)* · `auth/email.ts` *(new — reset/verify send)* · `app/routes/{refresh,password,keys,sessions-admin}.ts` *(new)* · `app/routes/oauth.ts` (resolve via identities, `issueSession`) · **delete `app/routes/auth.ts`** (§5.5, in P4) · `app/api/pair.ts` (`issueSession` + E2E-sealed refresh token, single-use delete, drop plaintext token) · `app/socket.ts` (connect revocation check, `renew-token`, expiry timer, `disconnectSession`) · `app/events/eventRouter.ts` (`connectionsForAccount`) · `auth/plugin.ts` (`sessionId`/`clientKind` decorators).

**crypto:** `pin.ts`/`pin.web.ts` *(new)* + `index(.web).ts` exports · `pin.test.ts` · **remove** `encodeRecoveryCode`/`decodeRecoveryCode` exports once web drops them (keep the file until P4 lands).

**wire:** schemas for refresh/password/reset/keys/sessions-admin bodies + `PinWrapped`/`DeviceWrapped` + the extended pairing sealed-payload version.

**cli:** `auth/credentials.ts` (new discriminated shape) · `auth/tokenProvider.ts` *(new)* · `auth/pin.ts` *(new)* · `auth/deviceKey.ts` *(new, OS keychain)* · `auth/login.ts` (post-pair PIN prompt, new shape) · `daemon/machineClient.ts` + **all token consumers** in §6.6 (thread `tokenProvider`) · `daemon/machineIntegration.ts` (unlock via PIN/device key; reduced-custody default).

**web:** `crypto/{key-storage,worker-handler,client,protocol}.ts` (`PinWrapped`, `unlock`, remove recovery) · `lib/session.ts` (refresh custody + silent refresh) · `lib/complete-oauth-sign-in.ts` + new password sign-in/PIN components · **delete** `lib/complete-challenge-sign-in.ts`, `lib/restore-recovery-code.ts`, `components/auth/recovery-code-*`, `features/settings/.../RecoverySection.tsx` · `features/auth/require-auth.tsx` (silent refresh before redirect) · `sync/apiSocket.ts` (renew + refresh-on-authError) · `features/settings` (device-sessions list + log-out-others).

---

## 12. Implementation TODO

Granular, checkable task list. Each phase ends with a **green gate** (`pnpm build && pnpm typecheck && pnpm test && pnpm lint`) and the phase's own acceptance check. Tasks are ordered within a phase; `[wire]`/`[server]`/`[crypto]`/`[cli]`/`[web]` tag the package. Do **not** start until the plan is approved.

### Phase 0 — Prep & decisions (no code)
- [x] Confirm **dev databases will be reset** (no `auth_identities` backfill) and announce it — existing key-only accounts become unreachable after P4. **Decision:** confirmed; local dev Postgres is disposable pre-launch, no backfill migration will be written.
- [x] Pick the transactional **email provider** for reset/verify (P2 dependency); add its env vars to `config.ts` design (e.g. `SMTP_URL` / provider API key). If none, decide the "reset disabled, OAuth-only recovery" fallback copy. **Decision:** `auth/email.ts` ships a small `EmailTransport` interface with a no-op/dev-logger transport as the default (logs the verify/reset link at `info` level) so the flow is fully testable without real SMTP; a real transport is pluggable later via `SMTP_URL` env (read, not yet implemented — logs a "not configured, using dev logger" notice instead of silently no-op-ing).
- [x] Add the `@node-rs/argon2` dependency decision (server + CLI PIN KDF) and confirm a matching **argon2id** primitive/params on the web side (libsodium `crypto_pwhash`) for blob portability. **Decision:** `@node-rs/argon2` added to `@falcon/crypto` (PIN KDF, node) and used directly by `@falcon/server`'s `auth/password.ts` (password hashing, PHC string). Web/browser argon2id uses `libsodium-wrappers-sumo` (not the slim `libsodium-wrappers` already in use elsewhere) because `crypto_pwhash` is sumo-only. Params unified in `packages/crypto/src/pin-params.ts` (memoryCost 64MiB, timeCost 3, parallelism 1, 16-byte salt matching libsodium's fixed `crypto_pwhash_SALTBYTES`) — verified byte-identical output both directions in `pin.test.ts`'s cross-platform parity vectors.
- [x] Unify the client server-URL env var (`FALCON_BACKEND_URL` vs `NEXT_PUBLIC_FALCON_API_URL` vs `NEXT_PUBLIC_API_URL`) — pick one canonical name per client, document, plan the startup log line. **Decision:** CLI keeps `FALCON_BACKEND_URL` (already canonical there); web standardizes on `NEXT_PUBLIC_FALCON_API_URL` as primary, with `NEXT_PUBLIC_API_URL` read as a deprecated fallback (with a one-time console warning) for back-compat — implemented in Phase 4/5 client work.
- [x] Decide refresh-token **lifetime policy**: absolute 60d (default) vs sliding — record in `docs/encryption.md` draft. **Decision:** absolute 60-day lifetime (plan default), recorded in `docs/encryption.md`.
- [x] Decide daemon default custody: **reduced-custody content bundle** (recommended) vs full masterSecret. **Decision:** reduced-custody content bundle is the daemon default (§6.5); interactive `falcon` foreground may still PIN-wrap the full `masterSecret`.

### Phase 1 — Server session/refresh foundation (no behavior change; access TTL stays 1h)
Schema
- [ ] `[server]` `schema.ts`: add `authIdentities` table (§3.1) incl. `emailVerified`.
- [ ] `[server]` `schema.ts`: add `deviceSessions` table with lineage columns (`previousRefreshTokenHash`, `previousRotatedAt`, `familyId`, `machineId`, `revokedAt`, `expiresAt`, `lastRefreshedAt`) + indexes (§3.2).
- [ ] `[server]` `schema.ts`: `accounts` → make `signPublicKey`/`contentPubKey` nullable, add `keyEpoch` default 0, **drop `oauthProvider`/`oauthSubject`** (§3.3).
- [ ] `[server]` `schema.ts`: add `keyEpoch` (default 1) to `machines`, `sessions`, `workspaces` (§3.4).
- [ ] `[server]` `schema.ts`: add `keyBindNonces` table (accountId, nonce, expiresAt) for §6.2.
- [ ] `[server]` `db:generate` migration; verify migrate-on-boot is idempotent (`db/migrate.ts`).
- [ ] `[server]` update `db/schema.test.ts` for new tables/columns.

Tokens & refresh
- [ ] `[server]` `auth/tokens.ts`: `ClientKind`, `TokenPayload{accountId,sessionId,clientKind}`, `mintAccessToken` with `sid`/`ct` claims; keep `ACCESS_TOKEN_TTL_SECONDS = 1h`.
- [ ] `[server]` `auth/tokens.ts`: `verifyToken` returns `sessionId`/`clientKind`; **reject tokens missing `sid`/`ct`** (→ null). Update `tokens.test.ts`.
- [ ] `[server]` `auth/token-cache.ts`: cache value carries new claims (type update only).
- [ ] `[server]` `auth/refresh.ts` *(new)*: `newRefreshToken`, `hashRefreshToken`, `issueSession` (§4.2) — `noUncheckedIndexedAccess`-safe. Unit tests.
- [ ] `[server]` `auth/password.ts` *(new)*: `hashPassword`/`verifyPassword` (argon2id). Unit test.
- [ ] `[wire]` schemas: `RefreshRequest`/`RefreshResponse`; `DeviceSession` row shape for admin list.
- [ ] `[server]` `app/routes/refresh.ts` *(new)*: `POST /v1/auth/refresh` — atomic rotate, grace-window branch, replay→family-revoke, unknown→401 (§4.3). Route registration.
- [ ] `[server]` `auth/plugin.ts`: decorate `request.sessionId`/`request.clientKind` from verified token.

Tests / gate
- [ ] `[server]` `refresh.test.ts`: happy rotate; replay-outside-grace → family revoked; replay-inside-grace → idempotent; unknown → 401; revoked/expired row → 401.
- [ ] **Gate:** build/typecheck/test/lint green. **Acceptance:** refresh works end-to-end via HTTP; no client wired yet; 1h tokens unchanged.

### Phase 2 — Identity routes, key-bind, pairing issues sessions
Email/OAuth identity
- [ ] `[server]` `auth/email.ts` *(new)*: send verification + reset emails (provider from Phase 0); no-op + disabled flag when unconfigured.
- [ ] `[wire]` schemas: password register/login/reset-request/reset-confirm bodies + responses.
- [ ] `[server]` `app/routes/password.ts` *(new)*: register (rate-limited, no-enumeration, sends verify email, `issueSession`), login (rate-limit + per-identity lockout, generic error), reset/request (always-200), reset/confirm (set hash, **revoke all sessions**) (§5.2–5.3).
- [ ] `[server]` `app/routes/oauth.ts`: resolve/create by `auth_identities(kind,subject)`; `issueSession` not `mintToken`; drop `signPubKey`/`contentPubKey` from body; verified-email linking guard (§5.4–5.5).
- [ ] `[server]` `app/routes/password.test.ts`, `oauth.test.ts`: enumeration-safe, rate-limit, lockout, reset revokes sessions, link-only-on-verified-email.

Key bind/rotate
- [ ] `[wire]` schemas: `keys/challenge` response, `keys/bind` body (signPubKey, contentPubKey, nonce, signature, rotate?, stepUpProof?).
- [ ] `[server]` `app/routes/keys.ts` *(new)*: `keys/challenge` (server nonce), `keys/bind` (verify sig over `accountId‖contentPubKey‖nonce`, first-bind vs rotate vs idempotent, step-up + online-device interlock, 409 conflict, txn revoke-other-sessions) (§6.2).
- [ ] `[server]` helpers: `consumeNonce`, `verifyStepUp`, `hasOtherHealthySessions`.
- [ ] `[server]` `keys.test.ts`: replayed nonce rejected; rotation blocked without step-up / while devices online; 409 on key-owned-by-another; idempotent re-bind no epoch bump; rotation revokes others.

Pairing → sessions (E2E-sealed refresh token)
- [ ] `[wire]`/`[crypto]`: bump pairing sealed-payload to `[0x01|masterSecret|refreshToken]`; version-tolerant decode.
- [ ] `[server]` `app/api/pair.ts`: `/approve` mints session server-side, returns refresh token to approver to seal; store **hash** in `device_sessions` + opaque blob in `pairRequests.response`; **drop `pairRequests.token`**; delete row single-use on authorized pickup (§6.3).
- [ ] `[server]` `pair.test.ts`: sealed refresh token round-trips; plaintext token column gone; single-use delete; hash-only storage.
- [ ] **Gate + Acceptance:** password/OAuth login and key-bind/rotate work over HTTP; pairing hands a device a real session with no plaintext token at rest.

### Phase 3 — PIN crypto module (parallelizable with P1/P2)
- [x] `[crypto]` `pin.ts` (node) + `pin.web.ts` (browser): `wrapWithPin`/`unwrapWithPin` — argon2id KDF (identical params both platforms), raw-bytes AES-256-GCM, fresh 12-byte nonce, `null` on wrong PIN (§6.1). **Deviation:** signatures are `Promise`-returning (async), not sync as the plan's illustrative snippet showed — argon2id at these params is CPU-bound (~100-300ms) and both the node (`@node-rs/argon2` `hashRaw`) and browser (libsodium WASM `crypto_pwhash`) calls are naturally promise-based; forcing sync would block the event loop / UI thread. Noted in `pin.ts`'s docblock.
- [x] `[crypto]` `index.ts`/`index.web.ts`: export `wrapWithPin`, `unwrapWithPin`, `PinWrapped` (+ `pinReady` on the web entry point, mirroring the existing `ready` export pattern for libsodium init).
- [x] `[crypto]` `pin.test.ts`: round-trip; wrong-PIN→null; nonce uniqueness; **cross-platform argon2id vector parity** (node blob unwraps on web params & vice versa). All 8 tests pass (`pnpm --filter @falcon/crypto test`).
- [x] **Gate + Acceptance:** module usable from both node and web builds; parity vector passes. `pnpm --filter @falcon/crypto build && typecheck && test` all green.

### Phase 4 — Web migration (PIN, silent refresh, remove recovery/challenge); then delete legacy `/v1/auth`
Crypto worker & storage
- [ ] `[web]` `crypto/key-storage.ts`: store `PinWrapped` instead of raw bytes.
- [ ] `[web]` `crypto/{worker-handler,client,protocol}.ts`: `init(masterSecret, pin)` → `wrapWithPin`+save; new `unlock(pin)`; no-key worker requires unlock; **remove `exportRecoveryCode`/`signInChallenge`-for-login usage**.
- [ ] `[web]` PIN UI: set-PIN (signup), enter-PIN (unlock on load), attempt counter → offer "start new key epoch" on repeated failure.

Identity & refresh
- [ ] `[web]` `lib/api.ts`: add refresh/password/reset/keys calls; remove `signIn` (challenge) wrapper.
- [ ] `[web]` `lib/session.ts`: refresh-token custody via **httpOnly cookie** (preferred) or worker-held; access token in memory; silent-refresh helper; cross-tab lock (`navigator.locks`).
- [ ] `[web]` password sign-in / sign-up pages + PIN set; wire OAuth callbacks to `issueSession` responses.
- [ ] `[web]` `lib/complete-oauth-sign-in.ts`: after register, generate masterSecret → set PIN → `keys/challenge`+`keys/bind` (epoch 1); **no recovery code shown**.
- [ ] `[web]` `features/auth/require-auth.tsx`: attempt one silent refresh before redirecting to `/signin/`.
- [ ] `[web]` `sync/apiSocket.ts`/`socket-factory.ts`: single silent refresh on auth `connect_error` before surfacing `authError` (renew event wired in P6).

Deletions
- [ ] `[web]` delete `lib/complete-challenge-sign-in.ts`, `lib/restore-recovery-code.ts`, `components/auth/recovery-code-*`, `features/settings/.../RecoverySection.tsx`, and the sign-in-page recovery restore branch.
- [ ] `[server]` **delete `app/routes/auth.ts`** (`POST /v1/auth`) + its registration, once the web no longer calls it. Remove `auth.test.ts`.
- [ ] `[crypto]` remove `encodeRecoveryCode`/`decodeRecoveryCode` exports (and `recovery.ts` if fully unused) — after web deletions land.

New-device chooser
- [ ] `[web]` "new device, no local key" screen: **pair from existing device** vs **start new key epoch** (destructive, confirms data loss copy from §5.4/§6.2).
- [ ] `[web]` tests: unlock flow; silent refresh replaces redirect; recovery UI gone; new-device chooser.
- [ ] **Gate + Acceptance:** full web signup/login/unlock/new-device works on 1h tokens; legacy route gone; no recovery code anywhere.

### Phase 5 — CLI/daemon migration (token provider, re-auth, custody)
- [ ] `[cli]` `auth/credentials.ts`: new discriminated `{refreshToken, keyMaterial: pin|device|plaintext-fallback}` shape + zod; read/write/clear; round-trip test.
- [ ] `[cli]` `auth/tokenProvider.ts` *(new)*: `getAccessToken` (cache to ~1m pre-exp), `forceRefresh`, persist rotated refresh token, dead-refresh → "run `falcon auth login`" message. Unit test.
- [ ] `[cli]` `auth/pin.ts` *(new)*: prompt PIN, wrap/unwrap (interactive foreground).
- [ ] `[cli]` `auth/deviceKey.ts` *(new)*: OS-keychain device-key wrap (macOS/libsecret/DPAPI) with documented `0600` fallback + warning log.
- [ ] `[cli]` `auth/login.ts`: after pairing, unseal masterSecret+refreshToken, prompt PIN (interactive) / device-wrap (daemon), write new shape.
- [ ] `[cli]` `daemon/machineIntegration.ts`: obtain masterSecret/content-bundle via unlock (PIN/device key); **reduced-custody default** for daemon; thread `tokenProvider`.
- [ ] `[cli]` `daemon/machineClient.ts`: Socket.IO `auth` async callback via `tokenProvider.getAccessToken`; `forceRefresh` on auth `connect_error`; proactive `renew-token` emit (server side lands P6).
- [ ] `[cli]` thread `tokenProvider` (replace `token: string`) through **all** consumers: `session/sessionClient.ts`, `daemon/blobClient.ts`, `daemon/unmanagedSessionClient.ts`, `daemon/githubChecks.ts`, `api/sessionMetadata.ts`, `commands/{start,startCodex,sessionsList,github}.ts` (§6.6).
- [ ] `[cli]` tests: tokenProvider refresh+persist; daemon re-auth after forced 401; three credential modes; reduced-custody path.
- [ ] **Gate + Acceptance:** `falcon auth login` → PIN → daemon runs, self-heals token on reconnect, survives past 1h.

### Phase 6 — Flip to short TTL + live WS lifecycle + admin UI
- [ ] `[server]` `auth/tokens.ts`: `ACCESS_TOKEN_TTL_SECONDS = 15m`.
- [ ] `[server]` `app/socket.ts`: connect-time revocation check (`revokedAt`/`expiresAt`); `renew-token` handler (re-validate, re-arm timer, no drop); expiry disconnect timer; `disconnectSession` (§4.5).
- [ ] `[server]` `app/events/eventRouter.ts`: `connectionsForAccount` accessor.
- [ ] `[wire]`/`[server]` `app/routes/sessions-admin.ts` *(new)*: list sessions, revoke one, revoke-others → disconnect live sockets.
- [ ] `[web]` proactive `renew-token` ~1m pre-exp; settings **device-sessions list + "log out other devices."**
- [ ] `[cli]` confirm proactive `renew-token` emit works against server; keep-alive across expiry (no flap).
- [ ] tests: revoked session dropped **immediately** on live WS; `renew-token` keeps socket up across expiry; no machine-presence flap at token boundary; revoke-others.
- [ ] **Gate + Acceptance:** 15m tokens with zero user-visible logout/flap; revocation immediate on WS, ≤15m on HTTP.

### Phase 7 — Cloud sandbox (deferred; design lands, build later)
- [ ] `[server]` accept `clientKind:"cloud-sandbox"` device sessions tied to a server-provisioned `machines` row.
- [ ] `[server]` per-session key custody for sandbox sessions (server-held or sandbox-wrapped DEK); flag via `workspaces.syncEnabled`/`sandboxConfig`.
- [ ] provisioning + revoke flow for a sandbox device session.
- [ ] docs: mark local = E2E, cloud = server-trusted, per-session.

### Cross-cutting / docs
- [ ] Update `docs/encryption.md`: PIN posture (casual-access, not offline-attacker), daemon custody limits, key-epoch rotation semantics, refresh lifetime policy.
- [ ] Update `docs/protocol.md` / `docs/falcon-system-design.md` §5.2/§6.2: new auth surface (`/auth/refresh`, password, keys, sessions-admin), remove `/v1/auth` challenge route.
- [ ] Update `docs/uninstall.md` if credential-file shape changes affect cleanup.
- [ ] Flip `docs/known-issues.md` #4 → Resolved (link this plan) once P1–P6 land.
- [ ] Security re-review of v2 (reuse-detection grace logic + rotation fence are the two to re-scrutinize) before P1 starts.
