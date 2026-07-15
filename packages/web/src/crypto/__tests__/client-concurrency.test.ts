import { describe, expect, it, vi } from "vitest";
import { createCryptoBridgeClient, type WorkerLike } from "../client.js";
import type { CryptoWorkerRequest, CryptoWorkerResponse } from "../protocol.js";

/**
 * A manually-driven `WorkerLike` double: unlike `loopback.ts`, this one does
 * NOT auto-respond. It just records every posted request so the test can
 * control exactly when/in what order responses get delivered back via
 * `worker.onmessage`. Used to exercise concurrency behavior that a
 * synchronous or FIFO-only double couldn't distinguish from a bug (e.g. the
 * client matching responses by id rather than by post order).
 */
function createManualWorker(): WorkerLike & { requests: CryptoWorkerRequest[] } {
  const requests: CryptoWorkerRequest[] = [];
  let deliver: WorkerLike["onmessage"] = null;
  return {
    requests,
    get onmessage() {
      return deliver;
    },
    set onmessage(handlerFn) {
      deliver = handlerFn;
    },
    postMessage(message) {
      requests.push(message);
    },
    terminate: vi.fn(),
    respond(response: CryptoWorkerResponse) {
      deliver?.({ data: response } as MessageEvent<CryptoWorkerResponse>);
    },
  } as WorkerLike & {
    requests: CryptoWorkerRequest[];
    respond(response: CryptoWorkerResponse): void;
  };
}

describe("createCryptoBridgeClient — request/response matching", () => {
  it("resolves each in-flight call with its own result, even when responses arrive out of order", async () => {
    const worker = createManualWorker() as ReturnType<typeof createManualWorker> & {
      respond(response: CryptoWorkerResponse): void;
    };
    const client = createCryptoBridgeClient(worker);

    const p1 = client.seal({ n: 1 });
    const p2 = client.seal({ n: 2 });
    const p3 = client.seal({ n: 3 });

    expect(worker.requests).toHaveLength(3);
    const [id1, id2, id3] = worker.requests.map((r) => r.id);

    // Deliver responses in reverse order of the requests that produced them.
    worker.respond({ id: id3!, ok: true, result: { t: "enc", v: 1, c: "c3" } });
    worker.respond({ id: id1!, ok: true, result: { t: "enc", v: 1, c: "c1" } });
    worker.respond({ id: id2!, ok: true, result: { t: "enc", v: 1, c: "c2" } });

    await expect(p1).resolves.toMatchObject({ c: "c1" });
    await expect(p2).resolves.toMatchObject({ c: "c2" });
    await expect(p3).resolves.toMatchObject({ c: "c3" });
  });

  it("rejects only the matching pending call on an error response, leaving others pending/unaffected", async () => {
    const worker = createManualWorker() as ReturnType<typeof createManualWorker> & {
      respond(response: CryptoWorkerResponse): void;
    };
    const client = createCryptoBridgeClient(worker);

    const ok = client.seal({ n: 1 });
    const bad = client.seal({ n: 2 });

    const [okId, badId] = worker.requests.map((r) => r.id);
    worker.respond({ id: badId!, ok: false, error: "boom" });
    worker.respond({ id: okId!, ok: true, result: { t: "enc", v: 1, c: "ok" } });

    await expect(bad).rejects.toThrow("boom");
    await expect(ok).resolves.toMatchObject({ c: "ok" });
  });

  it("ignores a response whose id has no matching pending call (already-settled or unknown id), without throwing", async () => {
    const worker = createManualWorker() as ReturnType<typeof createManualWorker> & {
      respond(response: CryptoWorkerResponse): void;
    };
    const client = createCryptoBridgeClient(worker);

    const p = client.seal({ n: 1 });
    const [id] = worker.requests.map((r) => r.id);

    // First delivery settles the call...
    worker.respond({ id: id!, ok: true, result: { t: "enc", v: 1, c: "once" } });
    await expect(p).resolves.toMatchObject({ c: "once" });

    // ...a duplicate/late redelivery of the same id, or a response to an id
    // that was never requested, must not throw.
    expect(() =>
      worker.respond({ id: id!, ok: true, result: { t: "enc", v: 1, c: "again" } }),
    ).not.toThrow();
    expect(() => worker.respond({ id: "never-requested", ok: false, error: "nope" })).not.toThrow();
  });

  it("assigns each call a distinct request id even when calls are issued synchronously back-to-back", () => {
    const worker = createManualWorker();
    const client = createCryptoBridgeClient(worker);

    void client.seal({ n: 1 });
    void client.seal({ n: 2 });
    void client.clear();

    const ids = worker.requests.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("terminate() forwards to the underlying worker's terminate()", () => {
    const worker = createManualWorker();
    const client = createCryptoBridgeClient(worker);
    client.terminate();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminate() does not throw when the underlying WorkerLike has no terminate()", () => {
    const worker: WorkerLike = {
      postMessage: vi.fn(),
      onmessage: null,
    };
    const client = createCryptoBridgeClient(worker);
    expect(() => client.terminate()).not.toThrow();
  });
});
