import type { AddressInfo } from "node:net";
import type { PGlite } from "@electric-sql/pglite";
import { deriveKeyTree, getRandomBytes } from "@kvy/crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestAccount,
  createTestDb,
  RecordingEventRouter,
} from "../../../server/src/app/routes/testHelpers.js";
// Cross-package source import (test-only): `@kvy/server` is a private,
// unpublished app package with no subpath `exports` map for its test
// utilities, so this reaches its TS source directly rather than through a
// built `dist/` entry point — same file the task names
// (packages/server/src/app/routes/testHelpers.ts). `@kvy/server` is
// declared as a devDependency in package.json for workspace-graph clarity
// even though the import itself is a relative path, not the package name.
import { buildServer } from "../../../server/src/app/server.js";
import { bootstrapSession } from "./bootstrap.js";

/**
 * Proves `bootstrapSession` against a real server (real Fastify app, real
 * HTTP round trip over an ephemeral port, real in-memory Postgres) rather
 * than a mocked fetch — the create-then-recreate-with-same-tag idempotency
 * guarantee this module leans on lives in `POST /v1/sessions`'s
 * anything this module does itself, so it's only meaningfully verified end
 * to end.
 */
describe("bootstrapSession (integration against a real server)", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let serverUrl: string;
  let token: string;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    app = await buildServer({ logger: false }, { db, eventRouter: new RecordingEventRouter() });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${address.port}`;

    const account = await createTestAccount(db);
    token = account.token;
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("create-then-recreate with the same tag returns the same session", async () => {
    const contentKeyPair = deriveKeyTree(getRandomBytes(32)).content;
    const deps = { serverUrl, fetchImpl: fetch, getAuthToken: () => token };
    const params = {
      machineId: "integration-machine",
      workspacePath: "/home/user/integration-project",
      nonce: "fixed-nonce",
      provider: "claude-code" as const,
      contentKeyPair,
      metadata: { title: "Integration session", path: "/home/user/integration-project" },
    };

    const first = await bootstrapSession(deps, params);
    const second = await bootstrapSession(deps, params);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.tag).toBe(first.tag);
    // The replay recovers the DEK the *first* call minted (and the server
    // actually stored), not whatever fresh DEK the second call generated
    // locally before finding out the row already existed.
    expect(second.dek).toEqual(first.dek);
  });

  it("a different nonce mints a distinct session even for the same machine/workspace", async () => {
    const contentKeyPair = deriveKeyTree(getRandomBytes(32)).content;
    const deps = { serverUrl, fetchImpl: fetch, getAuthToken: () => token };
    const base = {
      machineId: "integration-machine-2",
      workspacePath: "/home/user/integration-project-2",
      provider: "claude-code" as const,
      contentKeyPair,
      metadata: { title: "s", path: "/home/user/integration-project-2" },
    };

    const a = await bootstrapSession(deps, { ...base, nonce: "nonce-a" });
    const b = await bootstrapSession(deps, { ...base, nonce: "nonce-b" });

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
  });
});
