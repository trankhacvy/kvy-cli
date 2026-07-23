import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.js";

// A DB-free smoke test on the schema definitions themselves (table/column
// names, and that every EncryptedBox column uses the shared `bytea` custom
// type). Actual migration behavior is covered by running
// `drizzle-kit generate` + applying the migration against a real Postgres,
// not by this suite.
describe("db schema", () => {
  it("declares the tables named in the design doc (§6.1) and issue-4-plan.md §3", () => {
    const tableNames = [
      schema.accounts,
      schema.authIdentities,
      schema.deviceSessions,
      schema.keyBindNonces,
      schema.machines,
      schema.workspaces,
      schema.sessions,
      schema.sessionMessages,
      schema.unmanagedSessions,
      schema.pairRequests,
      schema.pushSubscriptions,
      schema.telegramLinkRequests,
      schema.blobs,
    ].map((t) => getTableConfig(t).name);

    expect(tableNames).toEqual([
      "accounts",
      "auth_identities",
      "device_sessions",
      "key_bind_nonces",
      "machines",
      "workspaces",
      "sessions",
      "session_messages",
      "unmanaged_sessions",
      "pair_requests",
      "push_subscriptions",
      "telegram_link_requests",
      "blobs",
    ]);
  });

  it("makes accounts.signPublicKey/contentPubKey nullable and adds a rotatable keyEpoch (issue-4-plan.md §3.3)", () => {
    const config = getTableConfig(schema.accounts);
    const signPublicKey = config.columns.find((c) => c.name === "sign_public_key");
    const contentPubKey = config.columns.find((c) => c.name === "content_pub_key");
    const keyEpoch = config.columns.find((c) => c.name === "key_epoch");

    expect(signPublicKey?.notNull).toBe(false);
    expect(contentPubKey?.notNull).toBe(false);
    expect(keyEpoch?.notNull).toBe(true);
  });

  it("tags every DEK-bearing row with the key epoch it was wrapped under (§3.4)", () => {
    for (const table of [schema.machines, schema.workspaces, schema.sessions]) {
      const keyEpoch = getTableConfig(table).columns.find((c) => c.name === "key_epoch");
      expect(keyEpoch?.notNull).toBe(true);
    }
  });

  it("device_sessions carries rotation lineage for theft detection (§3.2, §4.3)", () => {
    const config = getTableConfig(schema.deviceSessions);
    const columnNames = config.columns.map((c) => c.name);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "refresh_token_hash",
        "previous_refresh_token_hash",
        "previous_rotated_at",
        "family_id",
        "expires_at",
        "revoked_at",
      ]),
    );
    const refreshTokenHash = config.columns.find((c) => c.name === "refresh_token_hash");
    expect(refreshTokenHash?.isUnique).toBe(true);
  });

  it("uses the bytea custom type for every EncryptedBox column", () => {
    const byteaColumnsByTable: Record<string, string[]> = {
      accounts: ["settings"],
      machines: ["metadata", "daemon_state", "dek"],
      workspaces: ["metadata", "dek", "sandbox_config"],
      sessions: ["metadata", "agent_state", "dek"],
      session_messages: ["content"],
      unmanaged_sessions: ["summary", "dek"],
      pair_requests: ["response"],
    };

    for (const table of [
      schema.accounts,
      schema.machines,
      schema.workspaces,
      schema.sessions,
      schema.sessionMessages,
      schema.unmanagedSessions,
      schema.pairRequests,
    ]) {
      const config = getTableConfig(table);
      const expected = new Set(byteaColumnsByTable[config.name]);
      for (const column of config.columns) {
        if (expected.has(column.name)) {
          expect(column.getSQLType()).toBe("bytea");
        }
      }
    }
  });

  it("marks tag+accountId and session+seq/localId as unique (idempotency keys)", () => {
    const sessionsIndexes = getTableConfig(schema.sessions).indexes;
    expect(sessionsIndexes.some((i) => i.config.unique)).toBe(true);

    const messagesIndexes = getTableConfig(schema.sessionMessages).indexes;
    expect(messagesIndexes.filter((i) => i.config.unique)).toHaveLength(2);
  });

  it("requires expiresAt on pair requests (bounded pairing TTL)", () => {
    const config = getTableConfig(schema.pairRequests);
    const expiresAt = config.columns.find((c) => c.name === "expires_at");
    expect(expiresAt?.notNull).toBe(true);
  });
});
