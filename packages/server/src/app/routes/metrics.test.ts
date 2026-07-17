import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";

describe("GET /metrics", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it("responds 200 with a Prometheus text-exposition content type", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
  });

  it("exposes the rpc_calls_total metric registered by rpcHandler.ts (shared registry)", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.body).toContain("# HELP rpc_calls_total");
    expect(response.body).toContain("# TYPE rpc_calls_total counter");
  });

  it("exposes default Node.js process metrics (event loop lag, heap)", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.body).toContain("nodejs_eventloop_lag_seconds");
    expect(response.body).toContain("process_resident_memory_bytes");
  });

  it("counts an HTTP request made before the /metrics scrape itself", async () => {
    await app.inject({ method: "GET", url: "/health" });
    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.body).toContain('http_requests_total{method="GET",route="/health"');
  });

  it("labels an unknown route as 'unmatched' rather than the literal 404 path", async () => {
    await app.inject({ method: "GET", url: "/this-route-does-not-exist" });
    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.body).toContain('route="unmatched"');
    expect(response.body).not.toContain("this-route-does-not-exist");
  });

  it("404s on POST /metrics since only GET is registered", async () => {
    const response = await app.inject({ method: "POST", url: "/metrics" });
    expect([404, 405]).toContain(response.statusCode);
  });
});
