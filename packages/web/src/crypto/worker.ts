/**
 * crypto-bridge Worker entry point. Deliberately thin: all the logic worth
 * testing lives in `worker-handler.ts`; this file just wires that handler to
 * the Worker's global `postMessage`/`onmessage`. Loaded via
 * `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`
 * — see `factory.ts`.
 *
 * This is the only module in `crypto/` that runs *inside* the worker thread.
 * Nothing it imports transitively puts key bytes on a path back to
 * `postMessage` — see `worker-handler.ts` for the trust-boundary argument.
 */
import { createIndexedDbKeyStorage } from "./key-storage.js";
import type { CryptoWorkerRequest, CryptoWorkerErrResponse } from "./protocol.js";
import { createCryptoWorkerHandler } from "./worker-handler.js";

const handler = createCryptoWorkerHandler(createIndexedDbKeyStorage());

self.onmessage = (event: MessageEvent<CryptoWorkerRequest>) => {
  handler.handle(event.data).then(
    (response) => {
      self.postMessage(response);
    },
    (err: unknown) => {
      // Defense in depth: `handle()` currently wraps every branch in its own
      // try/catch and should never reject, but if a future edit adds an
      // `await` outside that try block, a rejection here must still surface
      // to the main-thread client as an `{ ok: false }` response instead of
      // being silently swallowed inside the Worker thread.
      const response: CryptoWorkerErrResponse = {
        id: event.data.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(response);
    },
  );
};
