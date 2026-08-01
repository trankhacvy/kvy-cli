import { createId } from "@paralleldrive/cuid2";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Raw Postgres `bytea` column holding an opaque `EncryptedBox` payload (see
 * `@kvy/wire`'s `box.ts`). The server stores and routes these bytes but
 * never decrypts them — it holds no keys (design §5.3, §6.1). Every column
 * using this type is a candidate for the wire-schema compat lint: payload
 * shapes are additive-only, forever.
 */
const bytea = customType<{ data: Uint8Array }>({
  dataType: () => "bytea",
});

// issue-4-plan.md §3.3: identity (auth) and key custody (encryption) are split.
// `signPublicKey`/`contentPubKey` are now nullable — a freshly-registered account has an
// identity (`auth_identities`) but no bound key material until `keys/bind` runs — and
// rotatable via `keyEpoch` (0 = no key bound yet; 1 = first bind; +1 per rotation, §6.2).
// The legacy `oauthProvider`/`oauthSubject` recovery-binding columns are dropped; OAuth is
// now a first-class login identity in `auth_identities`, not a fused recovery mechanism.
export const accounts = pgTable("accounts", {
  id: text("id").primaryKey().$defaultFn(createId),
  signPublicKey: text("sign_public_key").unique(), // hex; nullable until keys/bind
  contentPubKey: text("content_pub_key"),
  keyEpoch: integer("key_epoch").notNull().default(0),
  headerSeq: integer("header_seq").notNull().default(0), // account-level: HEADER changes only
  settings: bytea("settings"), // EncryptedBox
  // Plaintext (not part of the encrypted `settings` blob) because the push
  // dispatcher (`app/push/dispatch.ts`) must be able to check it without
  // decrypting anything — the server holds no keys (design §5.3). Per-account
  // "mute all" quiet control (PRD FR-8.3, plan.md §10).
  notificationsMutedAll: boolean("notifications_muted_all").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// issue-4-plan.md §3.1: a real login identity — password or OAuth — separate from key
// custody. `identifier` is the lowercased email for `kind:"password"`, the provider
// subject for `kind:"google"|"github"`. `emailVerified` gates account-linking (§5.4):
// an OAuth login only links to an existing password account when both sides are verified.
export const authIdentities = pgTable(
  "auth_identities",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'password' | 'google' | 'github'
    identifier: text("identifier").notNull(),
    passwordHash: text("password_hash"), // argon2id PHC string; null for oauth
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Security review finding F3: per-identity login lockout (issue-4-plan.md §5.2) — an
    // IP-rotating attacker defeats `password.ts`'s route-level Fastify rate limit alone,
    // so a wrong password against THIS identifier also counts here regardless of source
    // IP. `password.ts` resets `failedLoginCount` to 0 / clears `lockedUntil` on any
    // successful login. Both are irrelevant (stay null/0) for oauth-only identities.
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until"),
  },
  (t) => [uniqueIndex().on(t.kind, t.identifier), index().on(t.accountId)],
);

// issue-4-plan.md §3.2: a per-device refresh-token session. `refreshTokenHash`/
// `previousRefreshTokenHash` are sha256 hashes — the raw token is never stored. The
// previous-hash + `previousRotatedAt` pair is what makes theft detectable at
// `/v1/auth/refresh` (§4.3): a replay of a retired hash outside the grace window revokes
// the whole `familyId`. `expiresAt` is this session's absolute (not sliding) lifetime.
export const deviceSessions = pgTable(
  "device_sessions",
  {
    id: text("id").primaryKey().$defaultFn(createId), // JWT `sid`
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    refreshTokenHash: text("refresh_token_hash").notNull().unique(),
    previousRefreshTokenHash: text("previous_refresh_token_hash"),
    previousRotatedAt: timestamp("previous_rotated_at"),
    familyId: text("family_id").notNull(),
    clientKind: text("client_kind").notNull(), // 'web' | 'cli-daemon' | 'cli-session' | 'cloud-sandbox'
    label: text("label"),
    machineId: text("machine_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastRefreshedAt: timestamp("last_refreshed_at"),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index().on(t.accountId), index().on(t.familyId), index().on(t.previousRefreshTokenHash)],
);

// issue-4-plan.md §6.2: single-use, short-lived server nonces for `keys/challenge` +
// `keys/bind` — defeats the replayable client-chosen challenge the legacy `/v1/auth`
// route used (a signature over a nonce THIS server minted, not one the client picked).
export const keyBindNonces = pgTable("key_bind_nonces", {
  id: text("id").primaryKey().$defaultFn(createId),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  nonce: text("nonce").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
});

// issue-4-plan.md §5.3: single-use password-reset tokens, scoped to one `auth_identities`
// row (not the account directly — a reset only ever affects the password identity's
// hash; OAuth identities on the same account are untouched).
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: text("id").primaryKey().$defaultFn(createId),
  authIdentityId: text("auth_identity_id")
    .notNull()
    .references(() => authIdentities.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
});

export const machines = pgTable(
  "machines",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    metadata: bytea("metadata").notNull(), // enc: host, os, cliVersion…
    metadataVersion: integer("metadata_version").notNull().default(0),
    daemonState: bytea("daemon_state"), // enc: pid, port, startedAt…
    daemonStateVersion: integer("daemon_state_version").notNull().default(0),
    dek: bytea("dek").notNull(), // wrapped DEK
    keyEpoch: integer("key_epoch").notNull().default(1), // the account key epoch `dek` was wrapped under (§3.4)
    lastSeenAt: timestamp("last_seen_at"),
  },
  (t) => [index().on(t.accountId)],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    // Plaintext, client-minted (mirrors `sessions.tag`) — the absolute
    // workspace directory path, already sent in the clear elsewhere
    // (`SessionRow.workspaceId`), so no confidentiality is lost by using it
    // as this table's create-or-get idempotency key.
    path: text("path").notNull(),
    metadata: bytea("metadata").notNull(), // enc: baseBranch, remote
    metadataVersion: integer("metadata_version").notNull().default(0),
    dek: bytea("dek").notNull(),
    keyEpoch: integer("key_epoch").notNull().default(1), // the account key epoch `dek` was wrapped under (§3.4)
    // ---- deferred sandbox hooks (unused at MVP) ----
    syncEnabled: boolean("sync_enabled").notNull().default(false),
    sandboxConfig: bytea("sandbox_config"),
  },
  (t) => [uniqueIndex().on(t.accountId, t.path), index().on(t.accountId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id"),
    machineId: text("machine_id"),
    tag: text("tag").notNull(), // client-minted; creation idempotency
    provider: text("provider").notNull(), // 'claude-code' | 'codex'
    executionTarget: text("execution_target").notNull().default("local"), // 'sandbox' deferred
    status: text("status").notNull().default("active"),
    metadata: bytea("metadata").notNull(), // enc: title, path, providerSessionId…
    metadataVersion: integer("metadata_version").notNull().default(0),
    agentState: bytea("agent_state"), // enc: pending perms, control mode…
    agentStateVersion: integer("agent_state_version").notNull().default(0),
    dek: bytea("dek").notNull(),
    keyEpoch: integer("key_epoch").notNull().default(1), // the account key epoch `dek` was wrapped under (§3.4)
    msgSeq: integer("msg_seq").notNull().default(0), // per-session message counter
    // Plaintext for the same reason as `accounts.notificationsMutedAll` above
    // — the push dispatcher must be able to check it without decrypting
    // anything. Per-session "mute" quiet control (PRD FR-8.3, plan.md §10).
    notificationsMuted: boolean("notifications_muted").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.accountId, t.tag), index().on(t.accountId, t.updatedAt)],
);

export const sessionMessages = pgTable(
  "session_messages",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(), // per-session, gapless
    localId: text("local_id"), // sender idempotency
    content: bytea("content").notNull(), // EncryptedBox of SessionEnvelope[]
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.sessionId, t.seq), uniqueIndex().on(t.sessionId, t.localId)],
);

// Adoption Tier 1 (FR-9.1): provider sessions Kvy knows about but doesn't manage.
export const unmanagedSessions = pgTable(
  "unmanaged_sessions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    accountId: text("account_id").notNull(),
    machineId: text("machine_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    providerRef: text("provider_ref").notNull(), // opaque provider uuid
    summary: bytea("summary").notNull(), // enc: title, lastActivity, running?
    dek: bytea("dek").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.machineId, t.providerRef)],
);

// CLI device pairing (design §5.2): the server relays an opaque box, it can
// never read the key material inside `response`. `expiresAt` is a required
// TTL — an unbounded pairing window was one of the reported Happy vulns.
// issue-4-plan.md §6.3: the approver seals `[version|masterSecret|refreshToken]`
// end-to-end to the requester's ephemeral public key — `response` is that opaque box,
// the ONLY secret material this table (or the unauthenticated poll route that serves
// it) ever holds. There is deliberately no plaintext `token`/`refreshToken` column
// anymore: the CLI's device-session refresh token used to be relayed here in the
// clear (see git history), which meant a compromised database — or anyone who could
// read this table — held a live, usable credential. `app/api/pair.ts`'s approve
// route mints that refresh token server-side and hands it back to the (already
// authenticated) approving browser directly, out-of-band from this table, so the
// browser's crypto worker can seal it alongside the master secret before anything
// ever touches Postgres. The row is deleted, single-use, the moment a poller
// successfully reads back an authorized `response` — replaying the same `ephPub`
// after that starts a brand-new pairing attempt from `pending`, not a resend of the
// same secret.
export const pairRequests = pgTable("pair_requests", {
  id: text("id").primaryKey().$defaultFn(createId),
  ephPub: text("eph_pub").notNull().unique(), // requester's ephemeral X25519 pubkey, base64
  state: text("state").notNull().default("pending"), // 'pending' | 'authorized' | 'expired'
  response: bytea("response"), // sealed box to ephPub: [version|masterSecret|refreshToken]
  // docs/auth-ux-overhaul-plan.md AX-1.11: shown on the approver's confirm card so a
  // human can see WHAT they are approving. UNTRUSTED, attacker-controllable display
  // strings — length-capped at the route, rendered as plain text only, and never used
  // for any authorization decision.
  label: text("label"),
  cwd: text("cwd"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

/**
 * docs/auth-ux-overhaul-plan.md Phase 4: a device that already has an account session but
 * no key material asks one of the account's other devices for a copy.
 *
 * Deliberately a separate table from `pair_requests`, whose pickup route is
 * unauthenticated by necessity (a pairing CLI has no session yet) — every route touching
 * this one requires `app.authenticate` AND an `accountId` match, so a key request is only
 * ever visible to, approvable by, and claimable by the account that created it.
 *
 * `response` is the sealed box `[0x02 | masterSecret]`; the server cannot open it.
 */
export const keyRequests = pgTable(
  "key_requests",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    ephPub: text("eph_pub").notNull(),
    /**
     * The device session that RAISED the request. Only this session may claim the
     * response — an `accountId` match alone would let any session of the account,
     * including an attacker's, consume a legitimate delivery.
     */
    requestedBySessionId: text("requested_by_session_id").notNull(),
    /** Untrusted display string. Never used for an authorization decision. */
    label: text("label"),
    response: bytea("response"),
    approvedBySessionId: text("approved_by_session_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  // Scoped, NOT globally unique: a global unique index on `ephPub` would let anyone who
  // observes a broadcast key pre-insert a colliding row under their own account and
  // permanently deny delivery to the victim.
  (t) => [uniqueIndex().on(t.accountId, t.ephPub), index().on(t.accountId)],
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(), // 'webpush' | 'telegram' | 'ntfy'
    endpoint: text("endpoint").notNull().unique(), // push endpoint URL / chat id / topic
    keys: jsonb("keys"), // webpush p256dh/auth keys (unencrypted: transport, not content)
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index().on(t.accountId)],
);

// Telegram bot `/start` deep-link pairing (kvy-system-design.md §6.4,
// plan.md §10: "Fallback channels"). `code` is the opaque token embedded in
// the `https://t.me/<bot>?start=<code>` link; the webhook route
// (routes/telegramLink.ts) resolves it back to `accountId` once the user
// starts the bot, then deletes the row (single-use) and upserts a
// `push_subscriptions` row for the resulting chat id. Same bounded-TTL shape
// as `pairRequests` above, for the same reason: an unbounded pairing window
// is a standing vulnerability.
export const telegramLinkRequests = pgTable("telegram_link_requests", {
  id: text("id").primaryKey().$defaultFn(createId),
  code: text("code").notNull().unique(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

// Presigned-URL bookkeeping; the encrypted bytes themselves live in S3/R2 —
// see §5.3 (blobs never touch the DB, only their metadata does).
export const blobs = pgTable(
  "blobs",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    sessionId: text("session_id"),
    size: integer("size").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index().on(t.accountId)],
);
