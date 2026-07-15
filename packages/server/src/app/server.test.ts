import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

describe("buildServer", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it("responds 200 with a healthy payload on GET /health", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      status: "ok",
      uptimeSeconds: expect.any(Number),
      timestamp: expect.any(String),
    });
  });

  it("404s on an unknown route", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
  });
});
