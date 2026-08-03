const DEFAULT_BACKEND_URL = "https://api.kvy-cli.tkvy.dev";
const DEFAULT_FRONTEND_URL = "https://kvy-cli.tkvy.dev";

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
