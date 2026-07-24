import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

// docs/auth-ux-hardening-plan.md item 3 ("gate-password-prod"): with `FALCON_DEV_AUTH`
// off — the production default, and the only state `config.ts`'s `.refine()` allows under
// `NODE_ENV=production` — all four `password.ts` handlers must 404 rather than expose any
// email+password behavior (no enumeration oracle, no way to register/login/reset). See
// password.test.ts's own header comment for why this lives in a SEPARATE file: each
// vitest test file gets its own isolated module registry/worker, so this file's one
// `vi.resetModules()` + fresh `buildServer` import doesn't collide with that file's
// (`routes/metrics.ts`, pulled in by `server.ts`, registers process-level `prom-client`
// default metrics on import — a second fresh import of `server.ts` in the *same* worker
// throws "metric already registered", since `prom-client` itself lives in `node_modules`
// and isn't reset by `vi.resetModules()`).
const ORIGINAL_ENV = { ...process.env };

describe("password auth routes — FALCON_DEV_AUTH off (production gate, item 3)", () => {
  let pglite: PGlite;
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.FALCON_DEV_AUTH;
    vi.resetModules();
    const { buildServer } = await import("../server.js");

    pglite = new PGlite();
    const db = drizzle(pglite, { schema });
    await migrate(db, { migrationsFolder });
    app = await buildServer(
      { logger: false },
      {
        db,
        emailTransport: {
          async sendVerificationEmail() {},
          async sendResetEmail() {},
        },
      },
    );
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
    process.env = { ...ORIGINAL_ENV };
  });

  it("register 404s instead of creating an account", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/password/register",
      payload: { email: "gated@example.com", password: "whatever-password" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });
  });

  it("login 404s (not 401) — a gated deployment shouldn't even confirm the identity concept exists", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/password/login",
      payload: { email: "gated@example.com", password: "whatever-password" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });
  });

  it("reset/request 404s", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/password/reset/request",
      payload: { email: "gated@example.com" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });
  });

  it("reset/confirm 404s", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/password/reset/confirm",
      payload: { token: "some-token", password: "whatever-password" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });
  });

  // Review fix: the gate is wired as a `preValidation` hook specifically so it runs
  // BEFORE Fastify's zod body-schema validation — a check placed as the handler's first
  // statement only runs after validation already passed, so a malformed body would still
  // 400 "Bad Request" (revealing the route exists and its expected shape) instead of
  // getting the same 404 as a well-formed one. This must 404 identically to the
  // well-formed case above, not fall through to schema validation.
  it("still 404s (not 400) for a malformed body — the gate runs before schema validation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/password/register",
      payload: { notEmail: "this does not match the body schema at all" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });
  });

  // The malformed-body regression above only covers /register — `requireDevAuth` is wired
  // as the exact same `preValidation` hook on all four routes (password.ts), so the fix
  // must hold uniformly, not just for the one route that happened to get a test first.
  // Each of these payloads is deliberately shaped wrong for its OWN route's body schema
  // (e.g. reset/confirm's `password` must be min(8), reset/request has no `token` field at
  // all) to confirm schema validation never gets a chance to run on any of them.
  it("login also 404s (not 400) for a malformed body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/password/login",
      payload: { email: "not-an-email", password: 12345 },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });
  });

  it("reset/request also 404s (not 400) for a malformed body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/password/reset/request",
      payload: { notEmail: "wrong shape entirely" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });
  });

  it("reset/confirm also 404s (not 400) for a malformed body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/password/reset/confirm",
      payload: { token: "", password: "short" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });
  });
});
