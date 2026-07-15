import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumePendingPair, stashPendingPair } from "../pending-pair.js";
import { createMemoryStorage } from "./test-storage.js";

describe("pending-pair", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { sessionStorage: createMemoryStorage() };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("consumePendingPair returns null when nothing was stashed", () => {
    expect(consumePendingPair()).toBeNull();
  });

  it("round-trips a stashed ephPub through consumePendingPair", () => {
    stashPendingPair("eph-pub-base64==");
    expect(consumePendingPair()).toBe("eph-pub-base64==");
  });

  it("consumePendingPair is single-use — a second call returns null", () => {
    stashPendingPair("eph-pub-base64==");
    consumePendingPair();
    expect(consumePendingPair()).toBeNull();
  });

  it("a later stash overwrites an earlier, unconsumed one", () => {
    stashPendingPair("first");
    stashPendingPair("second");
    expect(consumePendingPair()).toBe("second");
  });
});
