/**
 * Real entry point for app code: spins up the actual crypto-bridge Worker
 * and wraps it in the typed client. Kept separate from `client.ts` so the
 * client's RPC logic can be unit-tested against a loopback double without
 * needing a real Worker (not available under Vitest's node environment).
 */
import { type CryptoBridgeClient, createCryptoBridgeClient } from "./client.js";

export function createCryptoBridge(): CryptoBridgeClient {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return createCryptoBridgeClient(worker);
}

export type { CryptoBridgeClient } from "./client.js";
