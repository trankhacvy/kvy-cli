# Production Deployment Runbook

Falcon on production: `@falcon/server` + Postgres on your infrastructure (Docker or VPS), web app on Vercel, blobs on Cloudflare R2.

## Pre-Deployment Checklist

### 1. Secrets & Keys

- [ ] Generate `FALCON_MASTER_SECRET` (HMAC key for auth JWTs)
  ```bash
  openssl rand -base64 32
  ```
- [ ] Cloudflare R2: Create bucket, generate API token
- [ ] OAuth apps: Register Google OIDC app, GitHub OAuth app (if needed)
- [ ] VAPID keypair for push notifications (if needed)
  ```bash
  pnpm --filter @falcon/server exec web-push generate-vapid-keys
  ```
- [ ] TLS certificates (Let's Encrypt via reverse proxy, or platform-managed)

### 2. Infrastructure

- [ ] Postgres 16 instance or managed database
- [ ] Server host (VPS, container platform, or Docker host)
- [ ] Reverse proxy (Nginx, Cloudflare, AWS ALB, etc.)
- [ ] DNS: `api.yourcompany.com` → reverse proxy → server
- [ ] DNS: `app.yourcompany.com` → Vercel (via CNAME)

### 3. Config Files

- [ ] **Server `.env`** (`deploy/.env.prod`): Fill in all REQUIRED fields
  - `FALCON_MASTER_SECRET`
  - `PUBLIC_WEB_ORIGIN` (Vercel domain)
  - `PUBLIC_API_ORIGIN` (your API domain)
  - R2 credentials (`S3_*`)
  - OAuth client IDs/secrets (if using)
  - VAPID keys (if using push)
- [ ] **Vercel env vars**: Set `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID`, etc.
- [ ] **Reverse proxy config**: Map `api.yourcompany.com` → `http://server:3005`
  - Set `X-Forwarded-For`, `X-Forwarded-Proto` headers
  - CORS: server reads `Origin` header, allowlist is `PUBLIC_WEB_ORIGIN`

## Deployment

### Option A: Docker (Recommended)

```bash
# On your server host
cd deployment-directory
cp deploy/.env.prod .env

# Fill in all required fields
nano .env

# Build and start
docker compose -f deploy/docker-compose.prod.yml up -d --build

# Watch logs
docker compose -f deploy/docker-compose.prod.yml logs -f server

# Verify health
curl http://localhost:3005/health
```

**Migrations run automatically on boot** — no separate migration step needed. If your
`DATABASE_URL` points at a connection pooler (PgBouncer, Neon's `-pooler` host, Vercel's
pooled URL), also set `DATABASE_URL_UNPOOLED` to the same database's **direct** connection
string — the migration runner needs it for its advisory lock and DDL transaction, and a
pooled connection there is what silently left `key_requests` un-migrated in one deployment.
Only the boot-time migrator reads this var; the request path keeps using `DATABASE_URL`. An
unreachable `DATABASE_URL_UNPOOLED` now fails boot loudly with a connection error rather than
falling back — a misconfigured value is a new way to fail, not a new way to silently degrade.

### Option B: VPS (Manual)

```bash
# 1. Install Node.js 20+, Postgres 16, npm/pnpm

# 2. Build @falcon/server
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @falcon/server build

# 3. Set env (e.g., /etc/falcon/env)
FALCON_MASTER_SECRET=...
DATABASE_URL=postgres://...
# ... (all other vars from .env.prod)

# 4. Start (systemd, PM2, or just tmux)
cd packages/server
node dist/main.js

# 5. Reverse-proxy Nginx/Apache to http://localhost:3005
```

### Option C: Container Platform (AWS ECS, K8s, etc.)

Use the provided `deploy/server.Dockerfile`:

```bash
# Build
docker build -f deploy/server.Dockerfile -t falcon-server:latest .

# Push to registry (AWS ECR, Docker Hub, etc.)
docker push <registry>/falcon-server:latest

# Deploy via platform's native orchestration
# Pass env vars via platform secrets manager (AWS Secrets Manager, K8s Secrets, etc.)
# DATABASE_URL, FALCON_MASTER_SECRET, S3_*, etc.
```

## Post-Deployment

### 1. Verify Services

```bash
# Server health
curl https://api.yourcompany.com/health

# Web app loads
curl https://app.yourcompany.com/

# Database connected (should see migrations run on startup)
# Check server logs: docker compose logs server
```

### 2. Test End-to-End

- [ ] Sign-up with email/password (only works when `NODE_ENV` isn't `production`; 404s in prod)
- [ ] Sign-in with Google/GitHub (if OAuth configured)
- [ ] Create a session (CLI or web)
- [ ] Verify transcript is encrypted server-side (server sees ciphertext only)
- [ ] Check blob upload (if S3/R2 configured)

### 3. Monitoring

- [ ] Enable server logs (JSON structured logging via pino)
- [ ] Set up log aggregation (ELK, Datadog, CloudWatch, etc.)
- [ ] Monitor Postgres (slow queries, connection pool)
- [ ] Monitor R2 costs (cheap but watch for runaway uploads)
- [ ] Vercel analytics (deployment trends, edge request metrics)

### 4. Backups

- [ ] Postgres: automated backups (managed provider, or cron pg_dump)
- [ ] R2: object lock or versioning enabled (cheap protection)
- [ ] `.env` files: encrypted store (1Password, Vault, etc.) — **never commit secrets**

## Scaling

### Horizontal (Multiple Server Replicas)

If you need to scale the server:

1. **Session stickiness** — WebSocket connections should route to the same instance
   - Reverse proxy should use connection-level routing, not request-level
   - Or use Redis for session state (future enhancement)

2. **Database** — ensure Postgres can handle concurrent connections
   - Connection pooling (PgBouncer) if many replicas
   - Managed Postgres (AWS RDS, Neon, etc.) handles this

3. **Migrations** — run automatically on boot, with advisory locks to prevent race conditions
   - Safe to scale multiple replicas simultaneously

4. **R2** — global, no changes needed

### Vertical (Bigger Instance)

- Scale up Postgres CPU/RAM
- Scale up server CPU/RAM
- Monitor with `top`, `docker stats`, Postgres slow query log

## Troubleshooting

### Server won't start

```bash
# Check .env is valid
docker compose -f docker-compose.prod.yml config

# Check database connection
docker compose -f docker-compose.prod.yml logs postgres

# Check migrations
docker compose -f docker-compose.prod.yml logs server | grep migration
```

### CORS errors in browser

- Verify `PUBLIC_WEB_ORIGIN` in server `.env` matches your Vercel domain
- Verify reverse proxy forwards `Origin` header (don't strip it)
- Check CORS logs: `server/src/app/security/cors.ts` debug output

### R2 upload fails

- Verify `S3_ENDPOINT` is correct (include `https://`)
- Verify `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` are R2 API token credentials (not master key)
- Verify `S3_BUCKET` exists in R2
- Check server logs for auth errors

### Vercel web app shows blank

- Check `NEXT_PUBLIC_API_URL` is set and correct
- Verify API is accessible from browser (not blocked by firewall/CDN)
- Check browser console for CORS errors

## Upgrades

```bash
# Pull latest code
git pull origin main

# Rebuild server image (migrations run on boot)
docker compose -f docker-compose.prod.yml up -d --build

# Redeploy web app to Vercel (auto on push, or manual via dashboard)
```

## Support & Links

- **Falcon system design:** `falcon-system-design.md`
- **Build plan:** `plan.md`
- **Auth hardening:** `docs/auth-ux-hardening-plan.md`
- **Vercel deployment:** `docs/VERCEL_DEPLOYMENT.md`
- **Cloudflare R2:** https://developers.cloudflare.com/r2/

---

**Questions?** Check the design docs or the `CLAUDE.md` runbooks in the repo root.
