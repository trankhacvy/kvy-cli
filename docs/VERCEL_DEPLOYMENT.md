# Kvy Web App Deployment on Vercel

`@kvy/web` is a **static Next.js export** — it ships as pre-built HTML/CSS/JS, never server-renders user content, and can run on any static host. Vercel is optimized for it.

## Setup Steps

### 1. Connect Repo to Vercel

```bash
# Vercel CLI
npm i -g vercel
vercel link                 # Connect this repo to Vercel
```

Or use Vercel Dashboard → "New Project" → Import this GitHub repo.

### 2. Environment Variables (Vercel Dashboard)

Go to **Settings → Environment Variables** and add:

| Name | Value | Type |
|------|-------|------|
| `NEXT_PUBLIC_API_URL` | `https://api.yourcompany.com` | Public |
| `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID` | `<from Google Cloud>` | Public |
| `NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID` | `<from GitHub OAuth App>` | Public |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | `<from web-push generate-vapid-keys>` | Public |

**Note:** All `NEXT_PUBLIC_*` vars are baked into the static bundle at **build time**. Change any of these → trigger a new deploy.

### 3. Root Directory (Build Settings)

- **Root Directory:** `packages/web`
- **Build Command:** `pnpm build` (or `pnpm -r build` if dependencies need rebuilding)
- **Output Directory:** `out` (Next.js static export destination)
- **Install Command:** `pnpm install --frozen-lockfile`

### 4. Custom Domain

**Vercel Dashboard → Domains:**
- Add your custom domain (e.g., `app.yourcompany.com`)
- Update DNS records per Vercel's instructions
- Vercel auto-provisions HTTPS via Let's Encrypt

### 5. Reverse Proxy (API Origin)

If your API server is behind a reverse proxy (Nginx, Cloudflare, etc.):

- **Public API origin** (what browsers see): `https://api.yourcompany.com`
- **Docker container** (internal): `localhost:3005`
- **Reverse proxy** maps `https://api.yourcompany.com` → `http://server:3005`

Update both:
- `PUBLIC_API_ORIGIN` in server `.env` (docker-compose.prod.yml)
- `NEXT_PUBLIC_API_URL` in Vercel env vars

Both must match for CORS + Subresource Integrity to work.

## Split-Origin Architecture

The web app talks to the API purely over **cross-origin fetch/WebSocket**:

1. **Web origin** (`https://app.yourcompany.com`) — Vercel static export
2. **API origin** (`https://api.yourcompany.com`) — Your server
3. **CORS allowlist** (`CORS_ALLOWED_ORIGINS` env var) — server checks `Origin` header
4. **CSP + SRI** (`deploy/web/default.conf.template`) — strict, no inline scripts

This split protects against:
- Server compromise leaking the web bundle
- CDN tampering with static assets (SRI integrity hashes)
- Cookie-based CSRF attacks (we use bearer tokens, never cookies)

## Deployment Workflow

```bash
# Local dev
pnpm --filter @kvy/web dev    # http://localhost:3000

# Stage/preview (auto, every push to a branch)
# Vercel builds and deploys to https://<branch>.yourapp.vercel.app

# Production (manual promotion or auto on main)
# Vercel builds and deploys to https://app.yourcompany.com
```

## Rebuild on API Origin Change

If you change `NEXT_PUBLIC_API_URL`:

1. **Vercel dashboard** → Environment Variables → update `NEXT_PUBLIC_API_URL`
2. **Trigger a rebuild** (or just push a commit)
3. Vercel re-runs `pnpm build` with the new env var baked in

**Why?** The API URL is a build-time constant (inlined into the static bundle). There's no server at request time to read env from.

## Monitoring

- **Vercel Dashboard** → Analytics → real-time deployment & edge request metrics
- **Error tracking** → integrate Sentry or similar (optional)
- **Uptime** → Vercel handles 99.95% uptime SLA

## Troubleshooting

**Blank page / 404 on routes:**
- Check that `next.config.ts` has `output: "export"` ✓
- Ensure `PUBLIC_API_URL` env var is set correctly

**CORS errors:**
- Verify `CORS_ALLOWED_ORIGINS` in server .env includes your Vercel domain
- Check that both web and API are using `https://` (not mixed http/https)

**SRI integrity failures:** shouldn't happen anymore — `next.config.ts` turns
`experimental.sri` off when `process.env.VERCEL` is set (Vercel sets this on
every build automatically), specifically because Vercel's edge has been
observed serving an `index.html` and a JS chunk from two different builds
whose SRI hashes don't match each other, which is fatal when the mismatched
chunk is the webpack runtime itself: a silently blank page, no console error
a user would see (the "resource blocked" message races Next's own
error-reporting code and loses). SRI stays on for the self-host nginx image,
which doesn't go through that CDN layer. If this resurfaces, it means
`next.config.ts`'s Vercel detection stopped matching — check
`vercel deploy` / dashboard build logs for `Experiments (use with caution): · sri`;
its *presence* on a Vercel build is the bug.

**OAuth provider buttons missing:**
- Check Vercel env vars: `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID`, etc.
- Vercel doesn't auto-expose `NEXT_PUBLIC_*` from `.env` — must set them in dashboard

---

**For more:** [Vercel static export docs](https://nextjs.org/docs/advanced-features/static-html-export)
