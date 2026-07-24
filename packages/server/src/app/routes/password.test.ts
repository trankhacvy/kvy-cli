import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmailTransport } from "../../auth/email.js";
import * as schema from "../../db/schema.js";
import { authIdentities, deviceSessions } from "../../db/schema.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

// docs/auth-ux-hardening-plan.md item 3 ("gate-password-prod"): the four password.ts
// handlers now 404 unless `FALCON_DEV_AUTH` is on (see password-gate.test.ts for the
// flag-off behavior, in its own file/worker — see that file's header comment for why).
// `config.ts`'s `env` singleton is parsed once from `process.env` at import time (same
// caveat as config.test.ts/oauth.test.ts), so exercising these routes with the flag on
// requires setting `process.env` *before* a fresh dynamic import of `buildServer`, not
// just before the `app.inject()` call. `vi.resetModules()` clears vitest's module
// registry so that fresh import re-runs `config.ts`'s top-level `EnvSchema.parse(...)`.
// Done exactly ONCE for this whole file (not per describe block) — `server.ts` pulls in
// `routes/metrics.ts`, which registers process-level `prom-client` default metrics on
// import; `prom-client` itself lives in `node_modules` and isn't reset by
// `vi.resetModules()`, so a second fresh import of `server.ts` in the *same* worker would
// throw "metric already registered". One import per file/worker avoids that.
const ORIGINAL_ENV = { ...process.env };

let buildServer: typeof import("../server.js").buildServer;
let verifyToken: typeof import("../../auth/index.js").verifyToken;

function recordingEmailTransport(): EmailTransport & {
  verifications: Array<{ to: string; verifyUrl: string }>;
  resets: Array<{ to: string; resetUrl: string }>;
} {
  const verifications: Array<{ to: string; verifyUrl: string }> = [];
  const resets: Array<{ to: string; resetUrl: string }> = [];
  return {
    verifications,
    resets,
    async sendVerificationEmail(params) {
      verifications.push(params);
    },
    async sendResetEmail(params) {
      resets.push(params);
    },
  };
}

async function buildApp() {
  const pglite = new PGlite();
  const db = drizzle(pglite, { schema });
  await migrate(db, { migrationsFolder });
  const email = recordingEmailTransport();
  const app = await buildServer({ logger: false }, { db, emailTransport: email });
  return { app, db, email, pglite };
}

describe("password auth routes — FALCON_DEV_AUTH=1 (local-testing surface, item 3)", () => {
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: FastifyInstance;
  let email: ReturnType<typeof recordingEmailTransport>;

  beforeAll(async () => {
    process.env = { ...ORIGINAL_ENV, FALCON_DEV_AUTH: "1" };
    vi.resetModules();
    ({ buildServer } = await import("../server.js"));
    ({ verifyToken } = await import("../../auth/index.js"));

    ({ app, db, email, pglite } = await buildApp());
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
    process.env = { ...ORIGINAL_ENV };
  });

  describe("POST /v1/auth/password/register", () => {
    it("creates an account + password identity and returns a valid session", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/password/register",
        payload: { email: "Alice@Example.com", password: "correct-horse-battery" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(typeof body.token).toBe("string");
      expect(body.token.length).toBeGreaterThan(0);

      const verified = await verifyToken(body.token);
      expect(verified?.accountId).toEqual(expect.any(String));

      // Email is stored lowercased/trimmed regardless of how it was submitted.
      const identity = await db.query.authIdentities.findFirst({
        where: eq(authIdentities.identifier, "alice@example.com"),
      });
      expect(identity?.kind).toBe("password");
      expect(identity?.emailVerified).toBe(false);
      expect(email.verifications).toHaveLength(1);
    });

    it("registering an already-used email returns the same generic success shape (no enumeration)", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/auth/password/register",
        payload: { email: "bob@example.com", password: "first-password-1" },
      });

      const second = await app.inject({
        method: "POST",
        url: "/v1/auth/password/register",
        payload: { email: "bob@example.com", password: "second-password-2" },
      });

      expect(second.statusCode).toBe(200);
      expect(second.json().success).toBe(true);

      // Only one identity row exists — the second call didn't create a duplicate account.
      const rows = await db
        .select()
        .from(authIdentities)
        .where(
          and(
            eq(authIdentities.kind, "password"),
            eq(authIdentities.identifier, "bob@example.com"),
          ),
        );
      expect(rows).toHaveLength(1);
    });

    it("rejects a too-short password", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/password/register",
        payload: { email: "short@example.com", password: "abc" },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("POST /v1/auth/password/login", () => {
    it("logs in with the correct password", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/auth/password/register",
        payload: { email: "carol@example.com", password: "carols-secret-pw" },
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/password/login",
        payload: { email: "carol@example.com", password: "carols-secret-pw" },
      });

      expect(response.statusCode).toBe(200);
      const verified = await verifyToken(response.json().token);
      expect(verified?.accountId).toEqual(expect.any(String));
    });

    it("rejects a wrong password with a generic error", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/auth/password/register",
        payload: { email: "dave@example.com", password: "daves-secret-pw" },
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/password/login",
        payload: { email: "dave@example.com", password: "wrong-password" },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Invalid email or password" });
    });

    it("rejects an unknown email with the exact same generic error (no enumeration)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/password/login",
        payload: { email: "nobody@example.com", password: "whatever" },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Invalid email or password" });
    });
  });

  // Security review finding F3: per-identity login lockout. Its own isolated
  // `app`/`db` (rather than reusing the describe block above's shared instance) so this
  // test's several back-to-back login attempts against ONE identity don't accumulate
  // against — or get skewed by — the shared instance's own per-IP rate-limit counter
  // and its other tests' already-issued login calls. Reuses the `buildServer` function
  // captured in the outer `beforeAll` above (no further `vi.resetModules()` here — see
  // this file's header comment on why that must happen at most once per file).
  describe("POST /v1/auth/password/login — lockout (security review finding F3)", () => {
    let lockoutPglite: PGlite;
    let lockoutDb: ReturnType<typeof drizzle<typeof schema>>;
    let lockoutApp: FastifyInstance;

    beforeAll(async () => {
      ({ app: lockoutApp, db: lockoutDb, pglite: lockoutPglite } = await buildApp());
      await lockoutApp.inject({
        method: "POST",
        url: "/v1/auth/password/register",
        payload: { email: "gina@example.com", password: "ginas-real-password" },
      });
    });

    afterAll(async () => {
      await lockoutApp.close();
      await lockoutPglite.close();
    });

    it("locks the identity out after repeated wrong passwords, rejecting even the correct password with the same generic error", async () => {
      let last: Awaited<ReturnType<typeof lockoutApp.inject>> | undefined;
      for (let i = 0; i < 5; i++) {
        last = await lockoutApp.inject({
          method: "POST",
          url: "/v1/auth/password/login",
          payload: { email: "gina@example.com", password: "wrong-guess" },
        });
        expect(last.statusCode).toBe(401);
      }
      // 5th consecutive failure crossed LOCKOUT_THRESHOLD — the identity is now locked.
      const identity = await lockoutDb.query.authIdentities.findFirst({
        where: eq(authIdentities.identifier, "gina@example.com"),
      });
      expect(identity?.failedLoginCount).toBe(5);
      const lockedUntil = identity?.lockedUntil ?? null;
      expect(lockedUntil).not.toBeNull();
      expect((lockedUntil as Date).getTime()).toBeGreaterThan(Date.now());

      // The CORRECT password is rejected too, with the exact same generic error — no
      // oracle distinguishing "locked out" from "wrong password".
      const correctWhileLocked = await lockoutApp.inject({
        method: "POST",
        url: "/v1/auth/password/login",
        payload: { email: "gina@example.com", password: "ginas-real-password" },
      });
      expect(correctWhileLocked.statusCode).toBe(401);
      expect(correctWhileLocked.json()).toEqual(last?.json());
    });

    it("a correct login resets the failure counter and lock for a DIFFERENT, never-failed identity", async () => {
      await lockoutApp.inject({
        method: "POST",
        url: "/v1/auth/password/register",
        payload: { email: "henry@example.com", password: "henrys-real-password" },
      });

      // One wrong guess — nowhere near the threshold — then the correct password.
      await lockoutApp.inject({
        method: "POST",
        url: "/v1/auth/password/login",
        payload: { email: "henry@example.com", password: "wrong-once" },
      });
      const success = await lockoutApp.inject({
        method: "POST",
        url: "/v1/auth/password/login",
        payload: { email: "henry@example.com", password: "henrys-real-password" },
      });
      expect(success.statusCode).toBe(200);

      const identity = await lockoutDb.query.authIdentities.findFirst({
        where: eq(authIdentities.identifier, "henry@example.com"),
      });
      expect(identity?.failedLoginCount).toBe(0);
      expect(identity?.lockedUntil).toBeNull();
    });
  });

  describe("password reset", () => {
    it("reset/request always 200s and reset/confirm changes the password + revokes sessions", async () => {
      const register = await app.inject({
        method: "POST",
        url: "/v1/auth/password/register",
        payload: { email: "erin@example.com", password: "erins-original-pw" },
      });
      const verified = await verifyToken(register.json().token);
      const accountId = verified?.accountId;
      expect(accountId).toBeTruthy();

      const before = email.resets.length;
      const requestResponse = await app.inject({
        method: "POST",
        url: "/v1/auth/password/reset/request",
        payload: { email: "erin@example.com" },
      });
      expect(requestResponse.statusCode).toBe(200);
      expect(email.resets).toHaveLength(before + 1);

      const resetUrl = email.resets[email.resets.length - 1]?.resetUrl ?? "";
      const token = resetUrl.split(": ")[1];
      expect(token).toBeTruthy();

      const confirmResponse = await app.inject({
        method: "POST",
        url: "/v1/auth/password/reset/confirm",
        payload: { token, password: "erins-new-password" },
      });
      expect(confirmResponse.statusCode).toBe(200);

      // All sessions issued before the reset were revoked (checked before logging back in,
      // since a fresh login mints a brand-new, un-revoked session of its own).
      const sessionsAfterReset = await db
        .select()
        .from(deviceSessions)
        .where(eq(deviceSessions.accountId, accountId as string));
      expect(sessionsAfterReset.length).toBeGreaterThan(0);
      expect(sessionsAfterReset.every((s) => s.revokedAt !== null)).toBe(true);

      // Old password no longer works.
      const oldLogin = await app.inject({
        method: "POST",
        url: "/v1/auth/password/login",
        payload: { email: "erin@example.com", password: "erins-original-pw" },
      });
      expect(oldLogin.statusCode).toBe(401);

      // New password works.
      const newLogin = await app.inject({
        method: "POST",
        url: "/v1/auth/password/login",
        payload: { email: "erin@example.com", password: "erins-new-password" },
      });
      expect(newLogin.statusCode).toBe(200);
    });

    it("reset/request 200s for an unknown email too, without sending anything (no enumeration)", async () => {
      const before = email.resets.length;
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/password/reset/request",
        payload: { email: "unknown-person@example.com" },
      });

      expect(response.statusCode).toBe(200);
      expect(email.resets.length).toBe(before);
    });

    it("rejects a reused reset token", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/auth/password/register",
        payload: { email: "frank@example.com", password: "franks-original-pw" },
      });
      await app.inject({
        method: "POST",
        url: "/v1/auth/password/reset/request",
        payload: { email: "frank@example.com" },
      });
      const resetUrl = email.resets[email.resets.length - 1]?.resetUrl ?? "";
      const token = resetUrl.split(": ")[1];

      const first = await app.inject({
        method: "POST",
        url: "/v1/auth/password/reset/confirm",
        payload: { token, password: "franks-new-pw-1" },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: "/v1/auth/password/reset/confirm",
        payload: { token, password: "franks-new-pw-2" },
      });
      expect(second.statusCode).toBe(401);
    });
  });
});
