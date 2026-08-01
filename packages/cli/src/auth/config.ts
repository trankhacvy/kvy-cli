/**
 * Backend/frontend URL resolution for the CLI's auth flows (kvy-plan.md
 * §2.1/§2.2, PRD §5.3: `KVY_BACKEND_URL`, `KVY_FRONTEND_URL`). Defaults
 * point at the production Kvy deployment named throughout
 * kvy-plan.md/kvy-system-design.md (`api.kvy.dev` / `app.kvy.dev`);
 * both are overridable for local dev against `pnpm --filter @kvy/server dev`.
 */

const DEFAULT_BACKEND_URL = "https://api.kvy.dev";
const DEFAULT_FRONTEND_URL = "https://app.kvy.dev";

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function resolveBackendUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KVY_BACKEND_URL?.trim();
  return stripTrailingSlash(override || DEFAULT_BACKEND_URL);
}

export function resolveFrontendUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KVY_FRONTEND_URL?.trim();
  return stripTrailingSlash(override || DEFAULT_FRONTEND_URL);
}
