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

  it("returns JSON content-type on /health", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("only exposes the fields declared in the response schema", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(["status", "timestamp", "uptimeSeconds"]);
  });

  it("405s (or 404s) on POST /health since only GET is registered", async () => {
    const response = await app.inject({ method: "POST", url: "/health" });
    expect([404, 405]).toContain(response.statusCode);
  });
});
