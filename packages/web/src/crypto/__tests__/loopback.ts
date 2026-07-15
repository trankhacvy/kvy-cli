/**
 * Test double standing in for a real Worker: wires `client.ts`'s `WorkerLike`
 * interface directly to a `CryptoWorkerHandler`, in-process, instead of
 * spinning up an actual Worker thread (Vitest's node environment has none,
 * and this is what real Workers can't give us anyway — the ability to
 * inspect every message that crosses the boundary).
 *
 * Every message handed to `postMessage` is round-tripped through
 * `structuredClone` (Node's global implementation of the same algorithm the
 * browser uses to move data into/out of a real Worker) before being recorded
 * and delivered — so a value that couldn't actually survive a postMessage
 * crossing (e.g. a class instance or a function) would fail here exactly
 * like it would in a browser.
 */
import type { WorkerLike } from "../client.js";
import type { CryptoWorkerRequest, CryptoWorkerResponse } from "../protocol.js";
import type { CryptoWorkerHandler } from "../worker-handler.js";

export interface Loopback extends WorkerLike {
  /** Every response the worker side has posted back to the main thread, in order. */
  responses: CryptoWorkerResponse[];
  /** Every request the main thread has posted to the worker, in order. */
  requests: CryptoWorkerRequest[];
}

export function createLoopbackWorker(handler: CryptoWorkerHandler): Loopback {
  const responses: CryptoWorkerResponse[] = [];
  const requests: CryptoWorkerRequest[] = [];
  let deliver: WorkerLike["onmessage"] = null;

  const loopback: Loopback = {
    responses,
    requests,
    get onmessage() {
      return deliver;
    },
    set onmessage(handlerFn) {
      deliver = handlerFn;
    },
    postMessage(message) {
      const clonedRequest = structuredClone(message);
      requests.push(clonedRequest);
      // Real Workers dispatch asynchronously, on a different thread's event
      // loop — queue a microtask so callers can't accidentally depend on
      // same-tick delivery.
      queueMicrotask(() => {
        handler.handle(clonedRequest).then((response) => {
          const clonedResponse = structuredClone(response);
          responses.push(clonedResponse);
          deliver?.({ data: clonedResponse } as MessageEvent<CryptoWorkerResponse>);
        });
      });
    },
  };

  return loopback;
}
