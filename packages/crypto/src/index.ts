/**
 * @falcon/crypto — node entry point (CLI, server). For the browser build
 * (libsodium-wrappers + WebCrypto AES-GCM), import "@falcon/crypto/web" instead.
 */
export * from './types.js';
export * from './base64.js';
export {
  getRandomBytes,
  libsodiumPublicKeyFromSecretKey,
  libsodiumEncryptForPublicKey,
  libsodiumDecryptWithSecretKey,
  encryptLegacy,
  decryptLegacy,
  encryptBlob,
  decryptBlob,
  encryptWithDataKey,
  decryptWithDataKey,
  encrypt,
  decrypt,
  authChallenge,
} from './encryption.js';
export { seal, open } from './box.js';
export { deriveKeyTree } from './keys.js';
export { wrapDek, unwrapDek } from './dek.js';
export { encodeRecoveryCode, decodeRecoveryCode } from './recovery.js';
