import type { PGlite } from "@electric-sql/pglite";
import { encodeBase64, getRandomBytes } from "@kvy/crypto";
import type { EncryptedBox } from "@kvy/wire";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmitEphemeralParams } from "../events/eventRouter.js";
import { buildServer } from "../server.js";
import {
  createTestAccount,
  createTestDb,
  RecordingEventRouter,
  RecordingPushDispatcher,
} from "./testHelpers.js";

function fakeBox(): EncryptedBox {
  return { t: "enc", v: 1, c: encodeBase64(getRandomBytes(16)) };
}

describe("POST /v1/sessions/:id/notify", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let eventRouter: RecordingEventRouter;
  let pushDispatcher: RecordingPushDispatcher;
  let authHeader: string;
  let accountId: string;
  let sessionId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    eventRouter = new RecordingEventRouter();
    pushDispatcher = new RecordingPushDispatcher();
    app = await buildServer({ logger: false }, { db, eventRouter, pushDispatcher });

    const account = await createTestAccount(db);
    authHeader = account.authHeader;
    accountId = account.account.id;

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: authHeader },
      payload: {
        tag: "notify-session",
        provider: "claude-code",
        metadata: fakeBox(),
        dek: encodeBase64(getRandomBytes(32)),
      },
    });
    sessionId = createResponse.json().id;
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it.each(["perm", "question", "done"] as const)(
    "fans out an attention ephemeral and dispatches a push for kind=%s",
    async (kind) => {
      const ephemerals: EmitEphemeralParams[] = [];
      const unsubscribe = eventRouter.onEphemeral((e) => ephemerals.push(e));
      pushDispatcher.calls.length = 0;

      const response = await app.inject({
        method: "POST",
        url: `/v1/sessions/${sessionId}/notify`,
        headers: { authorization: authHeader },
        payload: { kind },
      });
      unsubscribe();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });

      expect(ephemerals).toHaveLength(1);
      expect(ephemerals[0]?.payload).toEqual({ t: "attention", sessionId, kind });

      expect(pushDispatcher.calls).toHaveLength(1);
      expect(pushDispatcher.calls[0]).toEqual({ accountId, sessionId, kind });
    },
  );

  it("rejects an unknown kind", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/notify`,
      headers: { authorization: authHeader },
      payload: { kind: "failed" }, // has its own route (/status); not accepted here
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s for a session that doesn't belong to the caller", async () => {
    const { authHeader: otherHeader } = await createTestAccount(db);
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/notify`,
      headers: { authorization: otherHeader },
      payload: { kind: "done" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s for a nonexistent session id", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/does-not-exist/notify",
      headers: { authorization: authHeader },
      payload: { kind: "done" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("401s without an Authorization header", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/notify`,
      payload: { kind: "done" },
    });
    expect(response.statusCode).toBe(401);
  });
});
