/**
 * Sign-out teardown, extracted from `nav-user.tsx` so the step sequence is
 * unit-testable under this package's node-only vitest environment (no React
 * rendering). Three steps, in order:
 *
 * 1. Wipe key material — a throwaway crypto bridge whose worker `clear()`
 *    purges the shared IndexedDB store (`crypto/key-storage.ts`) and its own
 *    in-memory keys. There's deliberately no cross-page bridge singleton
 *    (`lib/use-crypto-bridge.ts`), so logout spins one up just to clear.
 * 2. Disconnect `apiSocket` — stops the infinite-reconnect loop before the
 *    token disappears, so it never fires a reconnect rejected with `null`
 *    auth.
 * 3. Clear the access token — last, so nothing above can observe a
 *    signed-out token state while still running.
 *
 * A key-wipe failure is logged but never aborts the sign-out (token clear +
 * redirect must always happen) — same "logout is best-effort past the crypto
 * step" posture as `client.ts`'s own doc comment.
 */
import { createCryptoBridge } from "@/crypto";
import { clearToken } from "@/lib/session";
import { apiSocket } from "@/sync";

export interface LogoutDeps {
  wipeKeyMaterial: () => Promise<void>;
  disconnectSocket: () => void;
  clearAccessToken: () => void;
}

async function wipeKeyMaterialWithThrowawayBridge(): Promise<void> {
  const bridge = createCryptoBridge();
  try {
    await bridge.clear();
  } finally {
    bridge.terminate();
  }
}

export async function logout(deps: Partial<LogoutDeps> = {}): Promise<void> {
  const wipeKeyMaterial = deps.wipeKeyMaterial ?? wipeKeyMaterialWithThrowawayBridge;
  const disconnectSocket = deps.disconnectSocket ?? (() => apiSocket.disconnect());
  const clearAccessToken = deps.clearAccessToken ?? clearToken;

  try {
    await wipeKeyMaterial();
  } catch (err) {
    console.error("logout: failed to wipe key material", err);
  }
  disconnectSocket();
  clearAccessToken();
}
