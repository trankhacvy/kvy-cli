import { describe, expect, it } from "vitest";
import { RpcRateLimiter } from "./rpcRateLimiter.js";

describe("RpcRateLimiter", () => {
  it("allows calls up to the max within the window", () => {
    const limiter = new RpcRateLimiter({ max: 3, windowMs: 1000 });

    expect(limiter.tryConsume("acct_1")).toBe(true);
    expect(limiter.tryConsume("acct_1")).toBe(true);
    expect(limiter.tryConsume("acct_1")).toBe(true);
  });

  it("rejects calls once the max is exceeded within the window", () => {
    const limiter = new RpcRateLimiter({ max: 2, windowMs: 1000 });

    expect(limiter.tryConsume("acct_1")).toBe(true);
    expect(limiter.tryConsume("acct_1")).toBe(true);
    expect(limiter.tryConsume("acct_1")).toBe(false);
    expect(limiter.tryConsume("acct_1")).toBe(false);
  });

  it("tracks each key independently", () => {
    const limiter = new RpcRateLimiter({ max: 1, windowMs: 1000 });

    expect(limiter.tryConsume("acct_1")).toBe(true);
    expect(limiter.tryConsume("acct_2")).toBe(true);
    expect(limiter.tryConsume("acct_1")).toBe(false);
    expect(limiter.tryConsume("acct_2")).toBe(false);
  });

  it("allows calls again once the window slides past old hits", () => {
    let now = 0;
    const limiter = new RpcRateLimiter({ max: 1, windowMs: 1000, now: () => now });

    expect(limiter.tryConsume("acct_1")).toBe(true);
    expect(limiter.tryConsume("acct_1")).toBe(false);

    now += 1001;
    expect(limiter.tryConsume("acct_1")).toBe(true);
  });

  it("evicts the oldest key once maxKeys is exceeded", () => {
    const limiter = new RpcRateLimiter({ max: 1, windowMs: 1000, maxKeys: 2 });

    expect(limiter.tryConsume("acct_1")).toBe(true); // fills slot 1
    expect(limiter.tryConsume("acct_2")).toBe(true); // fills slot 2
    expect(limiter.tryConsume("acct_3")).toBe(true); // evicts acct_1's entry

    // acct_1 was evicted, so it gets a fresh window instead of staying blocked.
    expect(limiter.tryConsume("acct_1")).toBe(true);
  });
});
