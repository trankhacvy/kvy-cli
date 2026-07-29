# Quick Start: Production Falcon Deployment

**Target:** Server + Postgres on Docker, web on Vercel, blobs on Cloudflare R2.

## 1. Generate Secrets

```bash
# FALCON_MASTER_SECRET (HMAC key for auth JWTs)
openssl rand -base64 32

# VAPID keypair (if using push notifications)
pnpm --filter @falcon/server exec web-push generate-vapid-keys
```

## 2. Set Up Cloudflare R2

- Create bucket in Cloudflare dashboard
- Create API token with read+write access
- Note your account ID
- R2 endpoint: `https://<account-id>.r2.cloudflarestorage.com`

## 3. Configure Server (.env)

Copy and fill in:

```bash
# deploy/.env.prod → deploy/.env

FALCON_MASTER_SECRET=<from step 1>
PUBLIC_WEB_ORIGIN=https://app.yourcompany.com
PUBLIC_API_ORIGIN=https://api.yourcompany.com
POSTGRES_PASSWORD=<strong-password>

# Cloudflare R2
S3_BUCKET=falcon-blobs
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=<R2 API token ID>
S3_SECRET_ACCESS_KEY=<R2 API token secret>

# OAuth (optional)
GOOGLE_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=

# Push notifications (optional)
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:support@yourcompany.com
```

## 4. Deploy Server

```bash
cd deploy
cp .env.prod .env
# ^ edit .env with your values

docker compose -f docker-compose.prod.yml up -d --build

# Verify
docker compose -f docker-compose.prod.yml logs -f server
curl http://localhost:3005/health
```

**Migrations run automatically on boot** — no manual migration step.

## 5. Configure Reverse Proxy

Map `api.yourcompany.com` → `http://server:3005` (or wherever Docker container is)

**Nginx example:**
```nginx
server {
  listen 443 ssl http2;
  server_name api.yourcompany.com;

  ssl_certificate /path/to/cert;
  ssl_certificate_key /path/to/key;

  location / {
    proxy_pass http://server:3005;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket support
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

## 6. Deploy Web App to Vercel

1. Connect repo to Vercel (dashboard or `vercel link`)
2. Set environment variables:
   - `NEXT_PUBLIC_API_URL=https://api.yourcompany.com`
   - `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID=<if using>`
   - `NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID=<if using>`
   - `NEXT_PUBLIC_VAPID_PUBLIC_KEY=<if using>`
3. Add custom domain: `app.yourcompany.com`
4. Vercel auto-builds on push to main

## 7. Verify Everything Works

```bash
# Server health
curl https://api.yourcompany.com/health

# Web app loads
curl https://app.yourcompany.com/ | head -20

# Try signing up / logging in via web UI
```

## Docs

- **Full runbook:** `docs/PROD_DEPLOYMENT_RUNBOOK.md`
- **Vercel setup:** `docs/VERCEL_DEPLOYMENT.md`
- **Architecture:** `../falcon-system-design.md`

## Key Env Vars Reference

| Var | Purpose | Required |
|-----|---------|----------|
| `FALCON_MASTER_SECRET` | JWT signing key | ✓ |
| `PUBLIC_WEB_ORIGIN` | Vercel domain | ✓ |
| `PUBLIC_API_ORIGIN` | API domain | ✓ |
| `S3_BUCKET` | R2 bucket name | ✓ |
| `S3_ENDPOINT` | R2 endpoint URL | ✓ |
| `S3_ACCESS_KEY_ID` | R2 API key | ✓ |
| `S3_SECRET_ACCESS_KEY` | R2 API secret | ✓ |
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth (optional) | |
| `GITHUB_OAUTH_CLIENT_ID` | OAuth (optional) | |
| `GITHUB_OAUTH_CLIENT_SECRET` | OAuth (optional) | |
| `VAPID_PUBLIC_KEY` | Push notifications (optional) | |
| `VAPID_PRIVATE_KEY` | Push notifications (optional) | |

---

**Done!** Your Falcon production stack is live.
Done
