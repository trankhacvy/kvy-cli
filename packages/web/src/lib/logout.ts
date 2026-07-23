/**
 * Sign-out teardown, extracted from `nav-user.tsx` so the step sequence is
 * unit-testable under this package's node-only vitest environment (no React
 * rendering). Three steps, in order:
 *
 * 1. Wipe key material — a throwaway crypto bridge whose worker `clear()`
 *    purges the shared IndexedDB store (`crypto/key-storage.ts`) and its own
 *    in-memory keys. `lib/use-crypto-bridge.ts`'s shared bridge singleton is
 *    for already-mounted feature components, not logout: this always spins
 *    up its own worker so it works the same whether or not anything else
 *    happens to be mounted right now.
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
import { markCryptoBridgeLocked } from "@/lib/use-crypto-bridge";
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
    // The shared bridge (if any other component still has it mounted through
    // the sign-out redirect) must not keep reporting "unlocked" once this
    // account's key material has just been wiped.
    markCryptoBridgeLocked();
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
