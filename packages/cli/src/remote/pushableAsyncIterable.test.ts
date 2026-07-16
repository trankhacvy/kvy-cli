import { describe, expect, it } from "vitest";
import { PushableAsyncIterable } from "./pushableAsyncIterable.js";

describe("PushableAsyncIterable", () => {
  it("delivers a value pushed before iteration starts", async () => {
    const it_ = new PushableAsyncIterable<number>();
    it_.push(1);
    const result = await it_.next();
    expect(result).toEqual({ done: false, value: 1 });
  });

  it("delivers values in push order (queued)", async () => {
    const it_ = new PushableAsyncIterable<string>();
    it_.push("a");
    it_.push("b");
    it_.push("c");
    expect(await it_.next()).toEqual({ done: false, value: "a" });
    expect(await it_.next()).toEqual({ done: false, value: "b" });
    expect(await it_.next()).toEqual({ done: false, value: "c" });
  });

  it("delivers a value pushed after next() is already waiting", async () => {
    const it_ = new PushableAsyncIterable<number>();
    const pending = it_.next();
    it_.push(42);
    expect(await pending).toEqual({ done: false, value: 42 });
  });

  it("resolves done:true once ended, for both a fresh and an already-waiting consumer", async () => {
    const it_ = new PushableAsyncIterable<number>();
    const pending = it_.next();
    it_.end();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await it_.next()).toEqual({ done: true, value: undefined });
  });

  it("drains any queued values before reporting done", async () => {
    const it_ = new PushableAsyncIterable<number>();
    it_.push(1);
    it_.end();
    expect(await it_.next()).toEqual({ done: false, value: 1 });
    expect(await it_.next()).toEqual({ done: true, value: undefined });
  });

  it("end() is idempotent", () => {
    const it_ = new PushableAsyncIterable<number>();
    it_.end();
    expect(() => it_.end()).not.toThrow();
    expect(it_.done).toBe(true);
  });

  it("throws on push() after end()", () => {
    const it_ = new PushableAsyncIterable<number>();
    it_.end();
    expect(() => it_.push(1)).toThrow(/completed/);
  });

  it("setError() rejects a waiting consumer and any subsequent next()", async () => {
    const it_ = new PushableAsyncIterable<number>();
    const pending = it_.next();
    const err = new Error("boom");
    it_.setError(err);
    await expect(pending).rejects.toThrow("boom");
    await expect(it_.next()).rejects.toThrow("boom");
    expect(it_.hasError).toBe(true);
  });

  it("push() throws the stored error once errored", () => {
    const it_ = new PushableAsyncIterable<number>();
    it_.setError(new Error("bad"));
    expect(() => it_.push(1)).toThrow("bad");
  });

  it("works end-to-end via for-await-of", async () => {
    const it_ = new PushableAsyncIterable<number>();
    it_.push(1);
    it_.push(2);
    it_.end();

    const seen: number[] = [];
    for await (const value of it_) seen.push(value);
    expect(seen).toEqual([1, 2]);
  });

  it("can only be iterated once via Symbol.asyncIterator", () => {
    const it_ = new PushableAsyncIterable<number>();
    it_[Symbol.asyncIterator]();
    expect(() => it_[Symbol.asyncIterator]()).toThrow(/only be iterated once/);
  });

  it("return() ends the iterable and reports done", async () => {
    const it_ = new PushableAsyncIterable<number>();
    const result = await it_.return();
    expect(result).toEqual({ done: true, value: undefined });
    expect(it_.done).toBe(true);
  });

  it("queueSize/waiterCount reflect pending state", async () => {
    const it_ = new PushableAsyncIterable<number>();
    expect(it_.queueSize).toBe(0);
    it_.push(1);
    expect(it_.queueSize).toBe(1);
    await it_.next();
    expect(it_.queueSize).toBe(0);

    const pending = it_.next();
    expect(it_.waiterCount).toBe(1);
    it_.push(2);
    await pending;
    expect(it_.waiterCount).toBe(0);
  });
});
