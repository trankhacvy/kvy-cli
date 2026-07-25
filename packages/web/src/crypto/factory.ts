/**
 * Real entry point for app code: spins up the actual crypto-bridge Worker
 * and wraps it in the typed client. Kept separate from `client.ts` so the
 * client's RPC logic can be unit-tested against a loopback double without
 * needing a real Worker (not available under Vitest's node environment).
 *
 * Loads `/crypto-worker.js`, a standalone bundle `scripts/build-worker.mjs`
 * produces from `worker.ts` at build time — not
 * `new Worker(new URL("./worker.ts", import.meta.url))`, webpack/Turbopack's
 * own chunk-splitting mechanism for this pattern, which resolves
 * inconsistently across bundlers/hosts for this app's static export (the
 * chunk URL a production Vercel build emits 404s; a local `next build`'s
 * doesn't). A fixed static path removes that variable entirely.
 */
import { type CryptoBridgeClient, createCryptoBridgeClient } from "./client.js";

export function createCryptoBridge(): CryptoBridgeClient {
  const worker = new Worker("/crypto-worker.js", { type: "module" });
  return createCryptoBridgeClient(worker);
}

export type { CryptoBridgeClient } from "./client.js";
