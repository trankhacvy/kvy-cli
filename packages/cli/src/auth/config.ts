/**
 * Backend/frontend URL resolution for the CLI's auth flows (falcon-plan.md
 * §2.1/§2.2, PRD §5.3: `FALCON_BACKEND_URL`, `FALCON_FRONTEND_URL`). Defaults
 * point at the production Falcon deployment named throughout
 * falcon-plan.md/falcon-system-design.md (`api.falcon.dev` / `app.falcon.dev`);
 * both are overridable for local dev against `pnpm --filter @falcon/server dev`.
 */

const DEFAULT_BACKEND_URL = "https://api.falcon.dev";
const DEFAULT_FRONTEND_URL = "https://app.falcon.dev";

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function resolveBackendUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FALCON_BACKEND_URL?.trim();
  return stripTrailingSlash(override || DEFAULT_BACKEND_URL);
}

export function resolveFrontendUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FALCON_FRONTEND_URL?.trim();
  return stripTrailingSlash(override || DEFAULT_FRONTEND_URL);
}
