import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { Counter, collectDefaultMetrics, Gauge, Histogram, register } from "prom-client";

// Prometheus scrape endpoint (kvy-system-design.md §6.2: "GET /health GET
// /metrics (bind-local)", plan.md §16 "4.4 Hardening & release gate":
// "Prometheus metrics + /metrics"). Exposes request rates, WS connection
// counts, RPC latency, and error rates as counters/histograms — never user
// content (design §13 "Observability": "No content, ever").
//
// "(bind-local)" in the design doc is a deployment-network concern, not
// something this route enforces itself: Fastify has no notion of "reachable
// only from this listener" once bound to one port, so operators must keep
// this path off the public ingress (scrape it from inside the private
// network / reverse-proxy allowlist) — same posture as `deploy/README.md`'s
// split-origin CSP notes for the web app. Documented in
// `docs/observability.md`.
//
// Reuses prom-client's default `register` — the exact same one
// `app/socket/rpcHandler.ts` already registers `rpc_calls_total` /
// `rpc_call_duration_seconds` / `rpc_lookup_retries` /
// `rpc_fetchsockets_timeouts_total` against (the RPC-latency metrics this
// task's plan.md line calls out), so one scrape of this endpoint picks up
// every metric registered anywhere in the process, not just the ones
// defined here.

// Standard Node.js/process metrics (event loop lag, heap, GC, open handles,
// process CPU/memory) — the usual baseline for any Prometheus-scraped Node
// service. Guarded so importing this module more than once in the same
// process (e.g. `buildServer()` is called once per test in *.test.ts files
// that share a module cache) doesn't call `collectDefaultMetrics` twice,
// which prom-client throws on ("A metric with the name ... has already been
// registered").
let defaultMetricsCollected = false;
function ensureDefaultMetricsCollected(): void {
  if (defaultMetricsCollected) return;
  collectDefaultMetrics({ register });
  defaultMetricsCollected = true;
}
ensureDefaultMetricsCollected();

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests by method, route, and status code",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [register],
});

export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds by method, route, and status code",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// Labeled by client scope (`session-scoped` / `machine-scoped` / `user-scoped`,
// `app/socket.ts`'s `ClientType`) so dashboards can tell a wave of daemon
// reconnects apart from a wave of browser tabs opening.
export const wsConnectionsActive = new Gauge({
  name: "ws_connections_active",
  help: "Currently open Socket.IO connections by client scope",
  labelNames: ["scope"] as const,
  registers: [register],
});

export const wsConnectionsTotal = new Counter({
  name: "ws_connections_total",
  help: "Total Socket.IO connections opened (cumulative) by client scope",
  labelNames: ["scope"] as const,
  registers: [register],
});

/**
 * Records one completed HTTP request/response. `route` should be the
 * *registered* path pattern (e.g. `/v1/sessions/:id/messages`,
 * `request.routeOptions.url`), never the literal request URL — labeling by
 * literal path would give every distinct session/message id its own label
 * series (unbounded cardinality), the same reasoning `rpcHandler.ts`'s
 * metrics already follow (labeled by RPC method, never by target id).
 */
export function recordHttpRequest(
  method: string,
  route: string,
  statusCode: number,
  durationSeconds: number,
): void {
  const labels = { method, route, status_code: String(statusCode) };
  httpRequestsTotal.inc(labels);
  httpRequestDurationSeconds.observe(labels, durationSeconds);
}

export function recordWsConnectionOpened(scope: string): void {
  wsConnectionsActive.inc({ scope });
  wsConnectionsTotal.inc({ scope });
}

export function recordWsConnectionClosed(scope: string): void {
  wsConnectionsActive.dec({ scope });
}

/**
 * `GET /metrics` — unauthenticated (a scrape target can't hold a bearer
 * token any more meaningfully than `/health` can). No `config.rateLimit`
 * override is registered for this route (same as `/health`), so it shares
 * the server's global default budget (300 req/min, keyed by IP since this
 * route is unauthenticated) rather than being excluded from rate limiting
 * — a normal Prometheus scrape interval (15-60s) is nowhere near that
 * budget in practice. If a deployment's scrape interval is ever aggressive
 * enough to matter, the fix is the standard one — put it behind a private
 * scrape network, per the module comment above, not throttle it in-process.
 */
export const metricsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", register.contentType);
    return await register.metrics();
  });
};
