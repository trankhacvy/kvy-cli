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

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey().$defaultFn(createId),
  signPublicKey: text("sign_public_key").notNull().unique(), // hex; identity anchor
  contentPubKey: text("content_pub_key").notNull(),
  oauthProvider: text("oauth_provider"), // recovery binding
  oauthSubject: text("oauth_subject"),
  headerSeq: integer("header_seq").notNull().default(0), // account-level: HEADER changes only
  settings: bytea("settings"), // EncryptedBox
  createdAt: timestamp("created_at").notNull().defaultNow(),
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
    msgSeq: integer("msg_seq").notNull().default(0), // per-session message counter
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
