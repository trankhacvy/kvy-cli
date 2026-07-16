import { createEnvelope, type SessionEnvelope } from "@falcon/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderedEnvelopeQueue } from "./outgoingQueue.js";

function textEnv(md: string): SessionEnvelope {
  return createEnvelope("agent", { t: "text", md });
}

function toolStart(call: string, name = "Bash"): SessionEnvelope {
  return createEnvelope("agent", { t: "tool-start", call, name, args: {} });
}

function toolEnd(call: string, ok = true): SessionEnvelope {
  return createEnvelope("agent", { t: "tool-end", call, ok });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("OrderedEnvelopeQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes non-tool-start envelopes immediately, in push order", async () => {
    const flushed: SessionEnvelope[] = [];
    const queue = new OrderedEnvelopeQueue({ onFlush: (e) => flushed.push(e) });

    queue.push(textEnv("one"));
    queue.push(textEnv("two"));
    await flushMicrotasks();

    expect(flushed.map((e) => (e.ev as { md: string }).md)).toEqual(["one", "two"]);
  });

  it("holds a tool-start back and blocks anything pushed after it", async () => {
    const flushed: SessionEnvelope[] = [];
    const queue = new OrderedEnvelopeQueue({ onFlush: (e) => flushed.push(e) });

    queue.push(toolStart("call-1"));
    queue.push(textEnv("after"));
    await flushMicrotasks();

    // Nothing released yet — the tool-start blocks the whole queue.
    expect(flushed).toEqual([]);
  });

  it("releases a pending tool-start immediately when its matching tool-end arrives", async () => {
    const flushed: SessionEnvelope[] = [];
    const queue = new OrderedEnvelopeQueue({ onFlush: (e) => flushed.push(e) });

    queue.push(toolStart("call-1"));
    queue.push(toolEnd("call-1"));
    await flushMicrotasks();

    expect(flushed.map((e) => e.ev.t)).toEqual(["tool-start", "tool-end"]);
  });

  it("auto-releases a tool-start after the delay if no tool-end arrives", async () => {
    const flushed: SessionEnvelope[] = [];
    const queue = new OrderedEnvelopeQueue({
      onFlush: (e) => flushed.push(e),
      toolStartDelayMs: 250,
    });

    queue.push(toolStart("call-1"));
    queue.push(textEnv("after"));

    await flushMicrotasks();
    expect(flushed).toEqual([]);

    vi.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(flushed.map((e) => e.ev.t)).toEqual(["tool-start", "text"]);
  });

  it("a tool-end for a DIFFERENT call id does not release an unrelated pending tool-start", async () => {
    const flushed: SessionEnvelope[] = [];
    const queue = new OrderedEnvelopeQueue({ onFlush: (e) => flushed.push(e) });

    queue.push(toolStart("call-1"));
    queue.push(toolEnd("call-2"));
    await flushMicrotasks();

    // call-2's tool-end has no pending tool-start of its own — it's released
    // (not a tool-start), but blocked behind call-1's still-pending one.
    expect(flushed).toEqual([]);

    vi.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(flushed.map((e) => e.ev.t)).toEqual(["tool-start", "tool-end"]);
  });

  it("flush() force-releases and drains everything immediately", async () => {
    const flushed: SessionEnvelope[] = [];
    const queue = new OrderedEnvelopeQueue({ onFlush: (e) => flushed.push(e) });

    queue.push(toolStart("call-1"));
    queue.push(textEnv("after"));
    queue.flush();
    await flushMicrotasks();

    expect(flushed.map((e) => e.ev.t)).toEqual(["tool-start", "text"]);
  });

  it("dispose() drops pending items and stops future flushes", async () => {
    const flushed: SessionEnvelope[] = [];
    const queue = new OrderedEnvelopeQueue({ onFlush: (e) => flushed.push(e) });

    queue.push(toolStart("call-1"));
    queue.dispose();
    queue.push(textEnv("ignored"));
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();

    expect(flushed).toEqual([]);
  });
});
