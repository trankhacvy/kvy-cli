import { describe, expect, it } from "vitest";
import { TokenCache } from "./token-cache.js";
import type { VerifiedToken } from "./tokens.js";

function payload(accountId: string, expiresAt: number): VerifiedToken {
  return { accountId, expiresAt, sessionId: `sess_${accountId}`, clientKind: "web" };
}

describe("TokenCache", () => {
  it("returns undefined on a miss", () => {
    const cache = new TokenCache();

    expect(cache.get("unknown-token")).toBeUndefined();
  });

  it("returns the cached payload on a hit", () => {
    const cache = new TokenCache({ now: () => 1_000 });

    cache.set("tok", payload("acct_1", 2_000));

    expect(cache.get("tok")).toEqual(payload("acct_1", 2_000));
    expect(cache.size).toBe(1);
  });

  it("evicts an entry once its expiresAt has passed", () => {
    let now = 1_000;
    const cache = new TokenCache({ now: () => now });
    cache.set("tok", payload("acct_1", 1_500));

    now = 1_500; // expiresAt <= now → expired

    expect(cache.get("tok")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("does not evict an entry before its expiresAt", () => {
    let now = 1_000;
    const cache = new TokenCache({ now: () => now });
    cache.set("tok", payload("acct_1", 1_500));

    now = 1_499;

    expect(cache.get("tok")).toEqual(payload("acct_1", 1_500));
  });

  it("refuses to cache an already-expired payload", () => {
    const cache = new TokenCache({ now: () => 2_000 });

    cache.set("tok", payload("acct_1", 1_000));

    expect(cache.get("tok")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest entry once maxSize is exceeded (FIFO)", () => {
    const cache = new TokenCache({ maxSize: 2, now: () => 0 });

    cache.set("a", payload("acct_a", 100));
    cache.set("b", payload("acct_b", 100));
    cache.set("c", payload("acct_c", 100));

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual(payload("acct_b", 100));
    expect(cache.get("c")).toEqual(payload("acct_c", 100));
    expect(cache.size).toBe(2);
  });

  it("re-setting an existing key does not count as a new entry toward maxSize", () => {
    const cache = new TokenCache({ maxSize: 2, now: () => 0 });

    cache.set("a", payload("acct_a", 100));
    cache.set("b", payload("acct_b", 100));
    cache.set("a", payload("acct_a", 200)); // update, not insert

    expect(cache.size).toBe(2);
    expect(cache.get("a")).toEqual(payload("acct_a", 200));
    expect(cache.get("b")).toEqual(payload("acct_b", 100));
  });

  it("delete removes a single entry", () => {
    const cache = new TokenCache({ now: () => 0 });
    cache.set("a", payload("acct_a", 100));

    cache.delete("a");

    expect(cache.get("a")).toBeUndefined();
  });

  it("clear empties the cache", () => {
    const cache = new TokenCache({ now: () => 0 });
    cache.set("a", payload("acct_a", 100));
    cache.set("b", payload("acct_b", 100));

    cache.clear();

    expect(cache.size).toBe(0);
  });
});
