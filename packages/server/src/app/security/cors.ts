// Explicit CORS allowlist (falcon-system-design.md §12, plan.md §16 "4.4 Hardening":
// "wildcard-CORS removal" — one of the reported Happy vuln classes). Socket.IO's `cors`
// option previously used `origin: "*"` — permitting `credentials: true` connections from
// *any* web origin, which defeats the point of an origin check entirely (browsers refuse
// to combine a wildcard origin with credentialed requests, so in practice this only ever
// protected non-browser clients, i.e. nothing). This module replaces that with a real
// allowlist check driven by `env.CORS_ALLOWED_ORIGINS`.
export type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;

/**
 * Builds a `(origin, callback) => void` validator matching the `cors` package's function
 * form that Socket.IO's `cors.origin` option accepts. Exact string match only — no
 * wildcard/subdomain patterns — since the allowlist is a short, operator-provided list of
 * real deployment origins (config.ts's `CORS_ALLOWED_ORIGINS`), not a public API.
 *
 * A request with no `Origin` header (same-origin browser navigation, or any non-browser
 * client — CLI/daemon machine sockets never send one) is allowed through: `Origin` is a
 * browser-enforced signal for cross-origin *browser* requests, not a general access
 * control mechanism, and Falcon's daemon/machine sockets authenticate via bearer token
 * (`socket.handshake.auth.token`, checked in `socket.ts`'s `io.use` middleware) regardless
 * of this check.
 */
export function buildCorsOriginValidator(
  allowedOrigins: readonly string[],
): (origin: string | undefined, callback: CorsOriginCallback) => void {
  const allowlist = new Set(allowedOrigins);

  return (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, allowlist.has(origin));
  };
}
