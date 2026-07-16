import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { mintToken } from "../../auth/index.js";
import * as schema from "../../db/schema.js";
import { accounts } from "../../db/schema.js";
import type {
  EmitEphemeralParams,
  EmitUpdateParams,
  EventRouterPort,
} from "../events/eventRouter.js";
import type { LifecycleKind, PushDispatcherPort } from "../push/types.js";

// In-memory Postgres (WASM, `@electric-sql/pglite`) migrated with the same
// SQL `drizzle-kit generate` produced for production (`packages/server/
// drizzle/`) — a real integration test against a real Postgres dialect,
// without a Docker/network dependency (same rationale as auth.test.ts,
// task 0.4).
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

/** Fresh in-memory Postgres + Drizzle instance, migrated and ready to use. */
export async function createTestDb() {
  const pglite = new PGlite();
  const db = drizzle(pglite, { schema });
  await migrate(db, { migrationsFolder });
  return { db, pglite };
}

/** Inserts a bare account row and mints a bearer token for it. */
export async function createTestAccount(db: ReturnType<typeof drizzle>) {
  const [account] = await db
    .insert(accounts)
    .values({
      signPublicKey: `test-${randomUUID()}`,
      contentPubKey: "test-content-pub-key",
    })
    .returning();
  if (!account) throw new Error("createTestAccount: insert returned no row");
  const token = await mintToken(account.id);
  return { account, token, authHeader: `Bearer ${token}` };
}

/**
 * Test double for `EventRouterPort` (the real implementation is
 * `events/eventRouter.ts`'s Socket.IO-backed singleton, which needs a live
 * `Server` bound via `.init()`). Route tests inject this instead so they
 * can assert on fan-out — "exactly one update/ephemeral emitted" — without
 * a real socket connection. `onUpdate`/`onEphemeral` return an unsubscribe
 * function so each `it` block can scope its capture window.
 */
export class RecordingEventRouter implements EventRouterPort {
  private readonly emitter = new EventEmitter();

  emitUpdate(params: EmitUpdateParams): void {
    this.emitter.emit("update", params);
  }

  emitEphemeral(params: EmitEphemeralParams): void {
    this.emitter.emit("ephemeral", params);
  }

  onUpdate(listener: (params: EmitUpdateParams) => void): () => void {
    this.emitter.on("update", listener);
    return () => this.emitter.off("update", listener);
  }

  onEphemeral(listener: (params: EmitEphemeralParams) => void): () => void {
    this.emitter.on("ephemeral", listener);
    return () => this.emitter.off("ephemeral", listener);
  }
}

/**
 * Test double for `PushDispatcherPort` (the real implementation is
 * `app/push/dispatch.ts`'s `buildPushDispatcher`, which hits the database
 * and real push channels). Route tests inject this so they can assert
 * "a dispatch was requested for this session/kind" without a real presence
 * check, subscription lookup, or Web Push send.
 */
export class RecordingPushDispatcher implements PushDispatcherPort {
  readonly calls: Array<{ accountId: string; sessionId: string; kind: LifecycleKind }> = [];

  async dispatch(params: {
    accountId: string;
    sessionId: string;
    kind: LifecycleKind;
  }): Promise<void> {
    this.calls.push(params);
  }
}
