import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.js";

// A DB-free smoke test on the schema definitions themselves (table/column
// names, and that every EncryptedBox column uses the shared `bytea` custom
// type). Actual migration behavior is covered by running
// `drizzle-kit generate` + applying the migration against a real Postgres,
// not by this suite.
describe("db schema", () => {
  it("declares the tables named in the design doc (§6.1)", () => {
    const tableNames = [
      schema.accounts,
      schema.machines,
      schema.workspaces,
      schema.sessions,
      schema.sessionMessages,
      schema.unmanagedSessions,
      schema.pairRequests,
      schema.pushSubscriptions,
      schema.blobs,
    ].map((t) => getTableConfig(t).name);

    expect(tableNames).toEqual([
      "accounts",
      "machines",
      "workspaces",
      "sessions",
      "session_messages",
      "unmanaged_sessions",
      "pair_requests",
      "push_subscriptions",
      "blobs",
    ]);
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
