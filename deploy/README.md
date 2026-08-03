# Deploying Kvy

Two shapes are supported:

1. **Self-host (all-in-one)** — `docker compose` runs server + Postgres + web on your
   own infrastructure. Simplest path, good default for self-hosting.
2. **Production (split infra)** — web on Vercel's static hosting, server on your own
   Docker/VPS host, Postgres managed (Neon, RDS, etc.), blobs on Cloudflare R2. What
   this repo's own hosted deployment uses.

Both share the same server image and the same migrate-on-boot behavior; the
difference is purely where each piece runs.

## What's in this directory

- **`server`** — `@kvy/server`, the Fastify API + Socket.IO stream.
- **`postgres`** — Postgres 16, the one and only supported dialect (self-host and
  production both run Drizzle against Postgres — no embedded-DB fork to maintain).
- **`web`** — the `@kvy/web` static export, served by its own nginx container **on a
  separate origin** from the API, with a strict Content-Security-Policy and
  Subresource Integrity on every JS/CSS asset.
- **`minio`** (optional, `--profile minio`) — an S3-compatible target for the
  blob-storage subsystem. Skip it entirely and blobs fall back to local disk — this is
  a capability tier, not a required piece.

Migrations run automatically on every server boot — there's no separate migration
step to remember (see "Migrate on boot" below).

---

## Option 1: Self-host with Docker Compose

```bash
cd deploy
cp .env.example .env
# edit .env: at minimum, set KVY_MASTER_SECRET
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

## Option 2: Production (split infra — Vercel + external Postgres + R2)

**Target:** `@kvy/server` + Postgres on your own Docker/VPS infra, web on Vercel,
blobs on Cloudflare R2.

### 1. Generate secrets

```bash
# KVY_MASTER_SECRET (HMAC key for auth JWTs)
openssl rand -base64 32

# VAPID keypair (if using push notifications)
pnpm --filter @kvy/server exec web-push generate-vapid-keys
```

### 2. Set up infrastructure

- Postgres 16 instance (managed — Neon, RDS — or self-run)
- A server host (VPS, container platform, or Docker host)
- A reverse proxy in front of it (Nginx, Cloudflare, AWS ALB, etc.)
- Cloudflare R2 bucket + API token with read+write access, for blob storage
- DNS: `api.yourcompany.com` → reverse proxy → server; `app.yourcompany.com` →
  Vercel (CNAME)
- OAuth apps if you want Google/GitHub sign-in (Google OIDC app, GitHub OAuth app);
  TLS via the reverse proxy or platform-managed certs

### 3. Configure

- **Server `.env`** (start from `deploy/.env.prod`): fill in `KVY_MASTER_SECRET`,
  `PUBLIC_WEB_ORIGIN` (your Vercel domain), `PUBLIC_API_ORIGIN` (your API domain),
  R2 credentials (`S3_*`), OAuth client IDs/secrets if using them, VAPID keys if
  using push.
- **Vercel env vars**: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID`,
  `NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY` — set in
  **Vercel Dashboard → Settings → Environment Variables**. All `NEXT_PUBLIC_*` vars
  are baked into the static bundle at **build time**; changing any of them requires
  a new deploy.
- **Reverse proxy**: map `api.yourcompany.com` → `http://server:3005`, forward
  `X-Forwarded-For`/`X-Forwarded-Proto`. CORS is enforced server-side via
  `PUBLIC_WEB_ORIGIN` — the `Origin` header must match exactly.

### 4. Deploy the web app (Vercel)

`@kvy/web` is a **static Next.js export** (`output: "export"`) — it never
server-renders user content, so it can run on any static host; Vercel is optimized
for it.

- **Vercel Dashboard → New Project** → import this repo (or `vercel link` via CLI).
- **Root Directory:** `packages/web`
- **Build Command:** `pnpm build` (or `pnpm -r build` if workspace deps need
  rebuilding)
- **Output Directory:** `out`
- **Install Command:** `pnpm install --frozen-lockfile`
- Add a custom domain under **Domains** (e.g. `app.yourcompany.com`) — Vercel
  auto-provisions HTTPS.
- Every push to a branch gets an automatic preview deploy at
  `https://<branch>.yourapp.vercel.app`; pushes to `main` (or manual promotion)
  deploy to production.

Rebuilding is required (not just redeploying) whenever `NEXT_PUBLIC_API_URL`
changes, since it's inlined into the static bundle at build time — there's no
server at request time to read env from.

### 5. Deploy the server

**Docker (recommended):**

```bash
cd deployment-directory
cp deploy/.env.prod .env
nano .env   # fill in all required fields

docker compose -f deploy/docker-compose.prod.yml up -d --build
docker compose -f deploy/docker-compose.prod.yml logs -f server
curl http://localhost:3005/health
```

**VPS (manual):**

```bash
# Node.js 20+, Postgres 16, pnpm installed
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @kvy/server build

# set env (e.g. /etc/kvy/env): KVY_MASTER_SECRET, DATABASE_URL, ...all vars from .env.prod

cd packages/server
node dist/main.js   # run under systemd/PM2/tmux, reverse-proxied by Nginx/Apache
```

**Container platform (AWS ECS, K8s, etc.):**

```bash
docker build -f deploy/server.Dockerfile -t kvy-server:latest .
docker push <registry>/kvy-server:latest
# deploy via the platform's own orchestration; pass env vars via its secrets manager
```

### 6. Verify

```bash
curl https://api.yourcompany.com/health
curl https://app.yourcompany.com/
```

- [ ] Sign-up with email/password works only when `NODE_ENV` isn't `production`
      (404s in prod by design — see "Email+password is dev/local-testing only" below)
- [ ] Sign-in with Google/GitHub, if configured
- [ ] Create a session (CLI or web) and confirm the server only ever sees ciphertext
- [ ] Blob upload works, if R2/S3 configured

### 7. Scaling notes

- **Horizontal (multiple server replicas):** WebSocket connections need
  connection-level (not request-level) routing at the reverse proxy for session
  stickiness. Migrations are safe to run from multiple replicas booting
  simultaneously — see "Migrate on boot" below.
- **Database:** connection pooling (PgBouncer) if running many replicas; a managed
  Postgres (RDS, Neon) handles this for you.
- **R2:** global by default, no changes needed as you scale.
- **Vertical:** scale up Postgres/server CPU-RAM as needed; watch with `top`,
  `docker stats`, Postgres slow-query log.

### 8. Upgrades

```bash
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build   # migrations run on boot
# redeploy web to Vercel (auto on push, or manual via dashboard)
```

---

## Shared behavior (both deployment shapes)

### Split-origin web + CSP/SRI

The web app talks to the API purely over **cross-origin fetch/WebSocket** — it is
never on the same origin as the API, in self-host or production:

1. **CORS allowlist** (`packages/server/src/app/security/cors.ts`,
   `packages/server/src/app/server.ts`). `CORS_ALLOWED_ORIGINS` (defaulted to
   `PUBLIC_WEB_ORIGIN` in `docker-compose.yml`) is the single allowlist both the
   plain HTTP API routes (`@fastify/cors`) and the `/v1/stream` Socket.IO endpoint
   check an `Origin` header against — exact match only, no wildcards. Auth is a
   bearer token in the `Authorization` header, never a cookie, so
   `Access-Control-Allow-Credentials` is never sent.
2. **Strict CSP + SRI** on the `web` container (`deploy/web/default.conf.template`,
   `packages/web/next.config.ts`'s `experimental.sri`). Every route gets a
   `Content-Security-Policy` header scoped to `'self'` plus the configured API
   origin (both its `http(s)` fetch form and its derived `ws(s)` WebSocket form) —
   no other origin is a valid script/style/connect/img target. Every JS/CSS file
   Next emits carries a build-time `integrity` attribute (sha256), so a compromised
   or tampered static host/CDN in front of this origin can't silently swap out a
   bundle without the browser refusing to run it. SRI is turned off automatically on
   Vercel builds specifically (see "SRI on Vercel" below) but stays on for the
   self-host nginx image.

This split protects against server compromise leaking the web bundle, CDN tampering
with static assets (SRI catches it), and cookie-based CSRF (there are no auth
cookies to steal).

**Rebuild `web` whenever the API origin changes** — `NEXT_PUBLIC_API_URL`/
`NEXT_PUBLIC_KVY_API_URL` are inlined into the static bundle at build time, so
`docker compose up -d --build` (not just `up -d`) after editing `PUBLIC_API_ORIGIN`
in `.env`, and likewise trigger a new Vercel build after changing
`NEXT_PUBLIC_API_URL` there.

### Migrate on boot

`packages/server/src/main.ts` calls `runMigrations()`
(`packages/server/src/db/migrate.ts`) before `app.listen` on every process start — a
bounded Postgres advisory lock (`pg_try_advisory_lock`, 10s of retries) keeps
concurrent boots (e.g. scaling `server` to multiple replicas) from racing each other
without being able to wedge one, and it's a no-op against an already-current
database. After migrating, it reads back the applied-migration count and throws if
it doesn't match the shipped `drizzle/meta/_journal.json` — a run that silently
applied nothing now fails boot loudly instead of starting against a stale schema.
`deploy/server-entrypoint.sh` is a thin, documented wrapper around `node
dist/main.js` for operators who want a hook point (pre-flight checks, secrets
fetch, ...) without duplicating the migration call itself.

**Set `DATABASE_URL_UNPOOLED` if `DATABASE_URL` goes through a connection pooler.**
`docker-compose.yml`'s own `postgres` service is a direct connection, so self-hosters
following the quick start above never need this. It matters if you point
`DATABASE_URL` at a managed Postgres pooler (PgBouncer, Neon's `-pooler` host,
Vercel's pooled URL): a session-scoped advisory lock is not reliably bound to one
backend under transaction pooling, which is exactly what let one deployment boot
with two pending migrations silently unapplied. Set `DATABASE_URL_UNPOOLED` to the
same database's direct endpoint — only `runMigrations()` uses it, the request path
stays on `DATABASE_URL`'s pool.

### Email+password is dev/local-testing only

Email+password (`POST /v1/auth/password/{register,login,reset/request,reset/confirm}`)
is gated on `NODE_ENV` directly (`password.ts`'s `requireNonProduction`), with no
operator opt-in: any deployment running with `NODE_ENV=production` gets a
fail-closed `404` on all four routes, unconditionally. There is no flag to
re-enable it there.

**If a deployment has existing password-only accounts** (from before this gate
existed, or from having run with a non-production `NODE_ENV` at some point),
confirm none of them depend on email+password as their *only* identity before
deploying with `NODE_ENV=production` — once gated, `password/login` 404s, and
there is no self-serve "reset keys via OAuth" recovery path for an account that
never linked a Google/GitHub identity. Run this against the deployment's own
Postgres first:

```sql
SELECT count(*) FROM auth_identities WHERE kind = 'password';
```

- **`0`** — nothing to migrate.
- **`> 0`** — there is currently no self-serve "link a Google/GitHub identity to an
  existing password account" flow, so those accounts lose their only way to log in
  the moment the deployment runs with `NODE_ENV=production`. Migrate every affected
  account out-of-band first (e.g. an operator-run script that inserts a matching
  `auth_identities` row of `kind = 'oauth'` for the same `account_id`, or direct
  support contact with the account holder).

### Blob storage: local disk vs. MinIO/S3

`packages/server/src/blobStorage/index.ts` selects the driver purely from env:
`S3_BUCKET` set ⇒ S3-compatible driver (works unmodified against real AWS S3/R2 or
MinIO); unset ⇒ local-disk driver, writing under `BLOB_LOCAL_DIR` (`/data/blobs` in
the self-host compose file, on the `kvy-server-data` volume). Leave it unset unless
you specifically want S3-compatible storage — local disk is the zero-config default.

If self-hosting with `--profile minio`: `S3_ENDPOINT` must be an address reachable
from **outside** the Docker network — the server hands presigned upload/download
URLs straight to browsers/CLIs, which can't resolve the internal `minio` hostname.
With the default port mapping that's `http://localhost:9000` (or your host's real
address/reverse-proxy hostname for a non-local deployment). `S3_FORCE_PATH_STYLE=true`
is required for MinIO. The bundled `minio-init` service creates the bucket named by
`S3_BUCKET` on first boot (idempotent — safe to leave running every start).

### Env reference

See `.env.example` (self-host) / `.env.prod` (production) — every variable mirrors
`packages/server/src/config.ts`'s zod schema one-to-one, including which ones are
required vs. optional. `config.ts`'s own comments document the rationale for each;
these files just wire them into the containers.

---

## Troubleshooting

**Server container exits immediately on boot in production** — almost always a
missing/too-short `KVY_MASTER_SECRET`; `config.ts` refuses to boot with the
dev-only default once `NODE_ENV=production`, and `docker-compose.yml` itself fails
the same way at `docker compose up` time if `.env` doesn't set it at all.

**Browser fetches from the web origin fail with a CORS error** —
`PUBLIC_WEB_ORIGIN`/`CORS_ALLOWED_ORIGINS` must be the *exact* origin (scheme + host
+ port) the browser actually loads the web app from; verify the reverse proxy
forwards the `Origin` header (don't strip it), and restart the server after
changing it (a plain restart is enough, no rebuild needed on that side).

**Web app can't reach the API after changing `PUBLIC_API_ORIGIN`/
`NEXT_PUBLIC_API_URL`** — that value is baked into the static bundle at build time;
you need a rebuild (`docker compose up -d --build`, or a new Vercel deploy), not
just a restart.

**R2/S3 upload fails** — verify `S3_ENDPOINT` includes `https://`,
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` are R2 API token credentials (not your
Cloudflare master key), and `S3_BUCKET` actually exists in R2. Check server logs
for the underlying auth error.

**Vercel web app shows blank** — check `NEXT_PUBLIC_API_URL` is set and correct,
and that the API is reachable from the browser (not blocked by firewall/CDN); check
the browser console for CORS errors first.

**SRI integrity failures on Vercel** — shouldn't happen: `next.config.ts` turns
`experimental.sri` off when `process.env.VERCEL` is set (Vercel sets this on every
build automatically), specifically because Vercel's edge has been observed serving
an `index.html` and a JS chunk from two different builds whose SRI hashes don't
match each other, which is fatal when the mismatched chunk is the webpack runtime
itself: a silently blank page, no console error a user would see. SRI stays on for
the self-host nginx image, which doesn't go through that CDN layer. If this
resurfaces, it means `next.config.ts`'s Vercel detection stopped matching — check
the build logs for `Experiments (use with caution): · sri`; its *presence* on a
Vercel build is the bug.

**OAuth provider buttons missing** — check `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID` /
`NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID` are set wherever the web app is built; Vercel
doesn't auto-expose `.env` file vars — they must be set in the dashboard.
