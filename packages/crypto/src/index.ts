/**
 * @kvy/crypto — node entry point (CLI, server). For the browser build
 * (libsodium-wrappers + WebCrypto AES-GCM), import "@kvy/crypto/web" instead.
 */

export * from "./base64.js";
export { open, seal } from "./box.js";
export { unwrapDek, wrapDek } from "./dek.js";
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
  getRandomBytes,
  libsodiumDecryptWithSecretKey,
  libsodiumEncryptForPublicKey,
  libsodiumPublicKeyFromSecretKey,
} from "./encryption.js";
export { deriveBlobKey, deriveKeyTree, signDetached, verifyDetached } from "./keys.js";
export { unwrapWithPin, wrapWithPin } from "./pin.js";
export * from "./types.js";
