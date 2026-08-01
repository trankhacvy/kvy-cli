import type { VerifiedToken } from "./tokens.js";

// kvy-plan.md §16 "0.4 Server foundation": "token cache" — the JWT signature check
// itself (jose/HS256) is cheap, but Kvy expects every request on a hot session to
// carry the same bearer token, so re-running verification on every single request is
// wasted work at scale. This cache lets the auth preHandler skip re-verification for a
// token it has already validated, until that token's own `exp` claim passes.
//
// In-memory only (per task scope — "in-memory (or equivalent)"): this is a single-process
// MVP server (kvy-plan.md §16), so a process-local cache is sufficient; it simply
// empties on restart, which is always safe (worst case: one extra verify per token).
export interface TokenCacheOptions {
  /** Upper bound on cached entries, oldest-inserted evicted first once exceeded. */
  maxSize?: number;
  /** Injectable clock for tests. Returns epoch seconds. */
  now?: () => number;
}

const DEFAULT_MAX_SIZE = 10_000;

export class TokenCache {
  private readonly entries = new Map<string, VerifiedToken>();
  private readonly maxSize: number;
  private readonly now: () => number;

  constructor(opts: TokenCacheOptions = {}) {
    this.maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get size(): number {
    return this.entries.size;
  }

  /** Returns the cached payload, or `undefined` on a miss or an expired entry. */
  get(token: string): VerifiedToken | undefined {
    const cached = this.entries.get(token);
    if (!cached) return undefined;

    if (cached.expiresAt <= this.now()) {
      this.entries.delete(token);
      return undefined;
    }

    return cached;
  }

  /** Caches an already-verified payload. Callers should only pass results of `verifyToken`. */
  set(token: string, payload: VerifiedToken): void {
    if (payload.expiresAt <= this.now()) return; // already expired — not worth caching

    if (!this.entries.has(token) && this.entries.size >= this.maxSize) {
      // Map preserves insertion order; the first key is the oldest entry (simple FIFO
      // eviction — good enough for a bearer-token cache, no need for full LRU here).
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }

    this.entries.set(token, payload);
  }

  delete(token: string): void {
    this.entries.delete(token);
  }

  clear(): void {
    this.entries.clear();
  }
}
