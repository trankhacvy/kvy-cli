// RPC calls travel over the `/v1/stream` Socket.IO connection, not Fastify HTTP routes —
// `@fastify/rate-limit` (server.ts's global default, and the per-route `config.rateLimit`
// used on `routes/*.ts`) never sees them at all. This is the WS-side equivalent, scoped to
// the one event that actually does work on behalf of a caller (`rpc-call`; `rpc-register`/
// `rpc-unregister` just join/leave a room and are cheap enough not to need their own limit)
// "auth/pairing/RPC endpoints" — one of the reported Happy vuln classes).
//
// Sliding-window counter, keyed by accountId (mirrors server.ts's HTTP keyGenerator so one
// account can't starve another sharing a Socket.IO room/process). In-memory only, same
// "single-process MVP, safe to lose on restart" stance as `auth/token-cache.ts`'s
// `TokenCache` — and, like that cache, FIFO-evicted past a max key count so a churn of
// short-lived accounts can't grow this unboundedly.
export interface RpcRateLimiterOptions {
  /** Max calls allowed per key within `windowMs`. */
  max: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** Upper bound on tracked keys, oldest-inserted evicted first once exceeded. */
  maxKeys?: number;
  /** Injectable clock for tests. Returns epoch milliseconds. */
  now?: () => number;
}

const DEFAULT_MAX_KEYS = 10_000;

export class RpcRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(opts: RpcRateLimiterOptions) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Records one call attempt for `key` and returns whether it's allowed under the
   * sliding window. Always records — including rejections — so a caller that keeps
   * hammering past the limit doesn't get a free reset each time it's checked.
   */
  tryConsume(key: string): boolean {
    const now = this.now();
    const windowStart = now - this.windowMs;

    const existing = this.hits.get(key);
    const recent = existing ? existing.filter((t) => t > windowStart) : [];

    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);

    if (!existing && this.hits.size >= this.maxKeys) {
      // Map preserves insertion order — same FIFO eviction as TokenCache.
      const oldestKey = this.hits.keys().next().value;
      if (oldestKey !== undefined) this.hits.delete(oldestKey);
    }
    this.hits.set(key, recent);
    return true;
  }
}
