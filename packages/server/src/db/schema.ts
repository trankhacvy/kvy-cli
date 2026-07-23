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
 * `@falcon/wire`'s `box.ts`). The server stores and routes these bytes but
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
  (t) => [
    index().on(t.accountId),
    index().on(t.familyId),
    index().on(t.previousRefreshTokenHash),
  ],
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

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey().$defaultFn(createId),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  metadata: bytea("metadata").notNull(), // enc: name, paths, baseRef, remote
  metadataVersion: integer("metadata_version").notNull().default(0),
  dek: bytea("dek").notNull(),
  keyEpoch: integer("key_epoch").notNull().default(1), // the account key epoch `dek` was wrapped under (§3.4)
  // ---- deferred sandbox hooks (unused at MVP) ----
  syncEnabled: boolean("sync_enabled").notNull().default(false),
  sandboxConfig: bytea("sandbox_config"),
});

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

// Adoption Tier 1 (FR-9.1): provider sessions Falcon knows about but doesn't manage.
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
export const pairRequests = pgTable("pair_requests", {
  id: text("id").primaryKey().$defaultFn(createId),
  ephPub: text("eph_pub").notNull().unique(), // requester's ephemeral X25519 pubkey, base64
  state: text("state").notNull().default("pending"), // 'pending' | 'authorized' | 'expired'
  response: bytea("response"), // sealed box to ephPub: master secret / content key bundle
  token: text("token"), // account access token, set once authorized
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

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

// Telegram bot `/start` deep-link pairing (falcon-system-design.md §6.4,
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
