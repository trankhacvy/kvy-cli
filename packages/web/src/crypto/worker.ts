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
import type { CryptoWorkerRequest } from "./protocol.js";
import { createCryptoWorkerHandler } from "./worker-handler.js";

const handler = createCryptoWorkerHandler(createIndexedDbKeyStorage());

self.onmessage = (event: MessageEvent<CryptoWorkerRequest>) => {
  handler.handle(event.data).then((response) => {
    self.postMessage(response);
  });
};
