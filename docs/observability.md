# Observability

> **Status:** stub — outline + pointers only, same convention as
> `docs/protocol.md`/`docs/encryption.md`. Backs `plan.md` §16 "4.4
> Hardening & release gate": "Prometheus metrics + `/metrics`". Full
> context: kvy-system-design.md §13 "Observability & Testing".

`@kvy/server` exposes `GET /metrics` in Prometheus text-exposition
format (`packages/server/src/app/routes/metrics.ts`). No user content is
ever in these metrics — they're operational counters/histograms only
(kvy-system-design.md §13: "No content, ever"), consistent with the
server's zero-knowledge posture everywhere else.

## What's exposed

| Metric | Type | Labels | What it measures |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status_code` | HTTP request rate + error rate (`rate(http_requests_total{status_code=~"5.."}[5m])`) |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status_code` | HTTP latency distribution |
| `ws_connections_active` | gauge | `scope` (`session-scoped` / `machine-scoped` / `user-scoped`) | Currently open Socket.IO connections |
| `ws_connections_total` | counter | `scope` | Cumulative Socket.IO connections opened |
| `rpc_calls_total` | counter | `method`, `result` | RPC call rate + outcome breakdown (`success` / `timeout` / `not_available` / `rate_limited` / …) |
| `rpc_call_duration_seconds` | histogram | `method`, `result` | RPC latency — the "RPC latency" metric plan.md §16 calls out by name |
| `rpc_lookup_retries` | histogram | `method` | Grace-window polls before an RPC target was found |
| `rpc_fetchsockets_timeouts_total` | counter | `context` | Cross-replica adapter lookup timeouts |
| `nodejs_*` / `process_*` | various | — | Standard `prom-client` defaults: event loop lag, heap, GC, open handles, process CPU/memory |

`route` is always the *registered path pattern* (e.g.
`/v1/sessions/:id/messages`), never the literal request path — labeling by
literal path would give every session/message id its own metric series
(unbounded cardinality). Unmatched routes (404s) are labeled `"unmatched"`.

The RPC metrics (`rpc_*`) are defined and incremented in
`app/socket/rpcHandler.ts`, not `routes/metrics.ts` — `/metrics` just
exposes whatever's registered against `prom-client`'s shared default
`register`, wherever in the process that happened. This is why scraping
one endpoint picks up every metric in the process without `routes/
metrics.ts` needing to know about `rpcHandler.ts` at all.

## Deployment note: keep this off the public ingress

kvy-system-design.md §6.2 lists this route as `GET /metrics
(bind-local)` — intentionally not something a random internet client
should be able to scrape. Fastify has no per-route "which listener" concept
once bound to one port, so this is an **operator responsibility**, not
something the route enforces itself:

- Behind a reverse proxy (nginx, the `deploy/` self-host image, a cloud
  load balancer): don't forward `/metrics` on the public vhost; scrape it
  from Prometheus over the private network instead.
- Same posture `deploy/README.md` already documents for the split-origin
  web app's CSP — public surface area is deliberately minimized at the
  network layer, not just the application layer.

## Pino logs

Structured JSON logs via `pino` (`src/logger.ts`), one line per request/
event, with `module` tags (`"websocket"`, `"push"`, …) for filtering.
Tokens and secrets are scrubbed via `pino`'s `redact` paths
(`P4-4.4-security-pass`) — never logged in plaintext, mirroring the "no
content, ever" rule metrics follow.

---

**TODO:** a real dashboard (Grafana JSON, or equivalent) once this has been
scraped in production long enough to know which panels are actually useful;
alerting rules (error-rate/latency SLOs from kvy-prd.md §8 "Success
Metrics" — p50 < 1.5s / p95 < 4s terminal→web event latency, etc.).
