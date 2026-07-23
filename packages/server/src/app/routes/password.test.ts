import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailTransport } from "../../auth/email.js";
import { verifyToken } from "../../auth/index.js";
import * as schema from "../../db/schema.js";
import { authIdentities, deviceSessions } from "../../db/schema.js";
import { buildServer } from "../server.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

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

describe("password auth routes", () => {
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: FastifyInstance;
  let email: ReturnType<typeof recordingEmailTransport>;

  beforeAll(async () => {
    pglite = new PGlite();
    db = drizzle(pglite, { schema });
    await migrate(db, { migrationsFolder });
    email = recordingEmailTransport();
    app = await buildServer({ logger: false }, { db, emailTransport: email });
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
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
