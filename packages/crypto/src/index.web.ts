/**
 * @kvy/crypto — browser entry point ("@kvy/crypto/web"). libsodium-wrappers
 * + WebCrypto AES-GCM. Call `await ready` once before using anything else from
 * this module (libsodium's WASM module needs to initialize) — see encryption.web.ts.
 *
 * Two functions differ in shape from the node build (`encryptWithDataKey`,
 * `decryptWithDataKey`, and therefore `seal`/`open`) because they're async
 * here — WebCrypto has no synchronous API. Wire formats are identical; a
 * ciphertext produced by one platform decrypts fine on the other.
 */

export * from "./base64.js";
export { open, seal } from "./box.web.js";
export { unwrapDek, wrapDek } from "./dek.web.js";
export {
  authChallenge,
  decrypt,
  decryptBlob,
  decryptLegacy,
  decryptWithDataKey,
  encrypt,
  encryptBlob,
  encryptLegacy,
  encryptWithDataKey,
  generateEphemeralKeyPair,
  getRandomBytes,
  libsodiumDecryptWithSecretKey,
  libsodiumEncryptForPublicKey,
  libsodiumPublicKeyFromSecretKey,
  ready,
} from "./encryption.web.js";
export { deriveBlobKey, deriveKeyTree, signDetached, verifyDetached } from "./keys.js";
export { pinReady, unwrapWithPin, wrapWithPin } from "./pin.web.js";
export * from "./types.js";
