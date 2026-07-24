# Self-hosting Falcon

`deploy/docker-compose.yml` runs the whole Falcon backend on your own
infrastructure (falcon-system-design.md §6.5, plan.md §16 "4.3 Distribution &
self-host"):

- **`server`** — `@falcon/server`, the Fastify API + Socket.IO stream.
- **`postgres`** — Postgres 16, the one and only supported dialect (prod and
  self-host both run Drizzle against Postgres — no embedded-DB fork to
  maintain).
- **`web`** — the `@falcon/web` static export, served by its own nginx
  container **on a separate origin** from the API, with a strict
  Content-Security-Policy and Subresource Integrity on every JS/CSS asset.
- **`minio`** (optional, `--profile minio`) — an S3-compatible target for the
  blob-storage subsystem. Skip it entirely and blobs fall back to local disk
  — this is a capability tier, not a required piece.

Migrations run automatically on every server boot — there's no separate
migration step to remember (see "Migrate on boot" below).

## Quick start

```bash
cd deploy
cp .env.example .env
# edit .env: at minimum, set FALCON_MASTER_SECRET
#   openssl rand -base64 32

docker compose up -d --build
```

That starts `postgres` + `server` + `web`. Once healthy:

- API: http://localhost:3005 (`GET /health`)
- Web: http://localhost:8080

Add MinIO for S3-compatible blob storage:

```bash
# uncomment the S3_*/MINIO_* lines in .env first
docker compose --profile minio up -d --build
```

Tear down (add `-v` to also drop the named volumes / all data):

```bash
docker compose down
```

## Split-origin web + CSP/SRI

The web app is a Next.js **static export** (`packages/web/next.config.ts`'s
`output: "export"`) — it never server-renders user content, so there's no
reason for it to share a process (or a container, or a domain) with the API.
`docker-compose.yml` runs it as its own nginx container on `WEB_PORT`
(default `8080`), talking to the API at `PUBLIC_API_ORIGIN` (default
`http://localhost:3005`) purely over the browser's normal cross-origin
fetch/WebSocket path.

Two things make that split-origin shape safe:

1. **CORS allowlist** (`packages/server/src/app/security/cors.ts`,
   `packages/server/src/app/server.ts`). `CORS_ALLOWED_ORIGINS` (defaulted to
   `PUBLIC_WEB_ORIGIN` in `docker-compose.yml`) is the single allowlist both
   the plain HTTP API routes (`@fastify/cors`) and the `/v1/stream`
   Socket.IO endpoint check an `Origin` header against — exact match only, no
   wildcards. Auth is a bearer token in the `Authorization` header, never a
   cookie, so `Access-Control-Allow-Credentials` is never sent.
2. **Strict CSP + SRI** on the `web` container
   (`deploy/web/default.conf.template`, `packages/web/next.config.ts`'s
   `experimental.sri`). Every route gets a `Content-Security-Policy` header
   scoped to `'self'` plus the configured API origin (both its `http(s)`
   fetch form and its derived `ws(s)` WebSocket form) — no other origin is a
   valid script/style/connect/img target. Every JS/CSS file Next emits
   carries a build-time `integrity` attribute (sha256), so a compromised or
   tampered static host/CDN in front of this origin can't silently swap out
   a bundle without the browser refusing to run it.

**Rebuild `web` whenever the API origin changes** — `NEXT_PUBLIC_API_URL`/
`NEXT_PUBLIC_FALCON_API_URL` are inlined into the static bundle at build
time (there's no server at request time to read env from), so
`docker compose up -d --build` (not just `up -d`) after editing
`PUBLIC_API_ORIGIN` in `.env`.

## Migrate on boot

`packages/server/src/main.ts` calls `runMigrations()`
(`packages/server/src/db/migrate.ts`) before `app.listen` on every process
start — a session-scoped Postgres advisory lock keeps concurrent boots (e.g.
scaling `server` to multiple replicas) from racing each other, and it's a
no-op against an already-current database. That's the entire "migrate on
boot" story; `deploy/server-entrypoint.sh` is a thin, documented wrapper
around `node dist/main.js` for operators who want a hook point (pre-flight
checks, secrets fetch, ...) without duplicating the migration call itself.

## Upgrading to the email+password production gate (docs/auth-ux-hardening-plan.md item 3)

Email+password (`POST /v1/auth/password/{register,login,reset/request,reset/confirm}`) is
dev/local-testing only — every self-host deployment that leaves `FALCON_DEV_AUTH` unset
(the default) gets a fail-closed `404` on all four routes instead of a live password
identity, matching the "no OAuth app configured yet" dev-bypass this flag already gates
(`config.ts`).

**Before upgrading a deployment that predates this gate**, confirm no existing account
depends on email+password as its *only* identity — once the gate is on, `password/login`
404s, and (per `docs/issue-4-plan.md`'s step-up design) the OAuth-only "reset keys" recovery
path can't help an account that never linked a Google/GitHub identity either. Run this
against the deployment's own Postgres before rolling the upgrade out:

```sql
SELECT count(*) FROM auth_identities WHERE kind = 'password';
```

- **`0`** — gating is safe as-is; nothing to migrate.
- **`> 0`** — there is currently no self-serve "link a Google/GitHub identity to an
  existing password account" flow, so flipping the gate on immediately locks those
  accounts out of login (and, per `docs/issue-4-plan.md`'s step-up design, out of the
  OAuth-only "reset keys" recovery path too, since they never linked a second identity).
  Do **not** enable this gate for a deployment with `count > 0` until either an
  account-linking flow ships, or every affected account has been migrated out-of-band
  (e.g. an operator-run script that inserts a matching `auth_identities` row of
  `kind = 'oauth'` for the same `account_id`, or direct support contact with the account
  holder). Keep `FALCON_DEV_AUTH=1` on that deployment in the meantime — it's the only
  thing keeping password login reachable there.

## Blob storage: local disk vs. MinIO/S3

`packages/server/src/blobStorage/index.ts` selects the driver purely from
env: `S3_BUCKET` set ⇒ S3-compatible driver (works unmodified against real
AWS S3/R2 or MinIO); unset ⇒ local-disk driver, writing under
`BLOB_LOCAL_DIR` (`/data/blobs` in this compose file, on the
`falcon-server-data` volume). Leave it unset unless you specifically want
S3-compatible storage — local disk is the zero-config default.

If you do enable `--profile minio`: `S3_ENDPOINT` must be an address
reachable from **outside** the Docker network — the server hands presigned
upload/download URLs straight to browsers/CLIs, which can't resolve the
internal `minio` hostname. With the default port mapping that's
`http://localhost:9000` (or your host's real address/reverse-proxy hostname
for a non-local deployment). `S3_FORCE_PATH_STYLE=true` is required for
MinIO. The bundled `minio-init` service creates the bucket named by
`S3_BUCKET` on first boot (idempotent — safe to leave running every start).

## Env reference

See `.env.example` — every variable mirrors
`packages/server/src/config.ts`'s zod schema one-to-one, including which
ones are required vs. optional. `config.ts`'s own comments document the
rationale for each; this file just wires them into the containers.

## Troubleshooting

- **Server container exits immediately on boot in production** — almost
  always a missing/too-short `FALCON_MASTER_SECRET`; `config.ts` refuses to
  boot with the dev-only default once `NODE_ENV=production`, and
  `docker-compose.yml` itself fails the same way at `docker compose up` time
  if `.env` doesn't set it at all.
- **Browser fetches from the web origin fail with a CORS error** —
  `PUBLIC_WEB_ORIGIN` in `.env` must be the *exact* origin (scheme + host +
  port) the browser actually loads the web app from; `docker compose up -d`
  after changing it (the server reads `CORS_ALLOWED_ORIGINS` at boot, so a
  plain restart — not a rebuild — is enough on that side).
- **Web app can't reach the API after changing `PUBLIC_API_ORIGIN`** — that
  value is baked into the static bundle at build time; you need
  `docker compose up -d --build`, not just `up -d`.
