/**
 * crypto-bridge — public surface for `packages/web/src/crypto/`.
 *
 * `createCryptoBridge()` is what app code calls: it spins up the actual
 * Worker and returns a typed client. Key material never leaves the worker —
 * see worker-handler.ts for the closure-based guarantee, and
 * `__tests__/client.test.ts` (using the `bytes-scan.ts` helper) for a test
 * asserting no response ever carries the raw secret bytes.
 */
export type { CryptoBridgeClient } from "./client.js";
export { createCryptoBridgeClient, type WorkerLike } from "./client.js";
export { createCryptoBridge } from "./factory.js";
export type { KeyProtection } from "./key-protection.js";
export { provisionKeyProtection, resolveWrapKeyForRecord } from "./key-protection.js";
export type { KeyWrapMode } from "./key-storage.js";
export { isPrfAvailable } from "./prf-key.js";
export type {
  CryptoWorkerRequest,
  CryptoWorkerResponse,
  DeviceIdentity,
  StorageDescription,
} from "./protocol.js";
