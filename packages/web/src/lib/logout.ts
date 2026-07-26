/**
 * Sign-out teardown, extracted from `nav-user.tsx` so the step sequence is
 * unit-testable under this package's node-only vitest environment (no React
 * rendering). Four steps, in order:
 *
 * 0. Stop the shared crypto-bridge worker — BEFORE wiping, so it can't answer a stray
 *    `describeStorage()` mid-teardown and re-open a database step 1 is about to delete
 *    (auth-ux-overhaul-e2e-results.md E2E-5.5). Skips `use-crypto-bridge.ts`'s normal
 *    2-second release grace: that grace exists to survive a route change, which is the
 *    opposite of what sign-out wants.
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
import { terminateSharedCryptoBridge } from "@/lib/use-crypto-bridge";
import { apiSocket } from "@/sync";

export interface LogoutDeps {
  stopSharedBridge: () => void;
  wipeKeyMaterial: () => Promise<void>;
  disconnectSocket: () => void;
  clearAccessToken: () => void;
}

async function wipeKeyMaterialWithThrowawayBridge(): Promise<void> {
  const bridge = createCryptoBridge();
  try {
    // Clears the key store AND the session store — the refresh token lives in its own
    // store now, so wiping only the former would leave a usable credential behind.
    await bridge.clear();
  } finally {
    bridge.terminate();
  }
}

export async function logout(deps: Partial<LogoutDeps> = {}): Promise<void> {
  const stopSharedBridge = deps.stopSharedBridge ?? terminateSharedCryptoBridge;
  const wipeKeyMaterial = deps.wipeKeyMaterial ?? wipeKeyMaterialWithThrowawayBridge;
  const disconnectSocket = deps.disconnectSocket ?? (() => apiSocket.disconnect());
  const clearAccessToken = deps.clearAccessToken ?? clearToken;

  // Step 0: stop the shared worker before wiping, so it can't answer a stray
  // `describeStorage()` mid-teardown and re-open a database we're about to delete.
  try {
    stopSharedBridge();
  } catch (err) {
    console.error("logout: failed to stop the shared crypto bridge", err);
  }
  try {
    await wipeKeyMaterial();
  } catch (err) {
    console.error("logout: failed to wipe key material", err);
  }
  disconnectSocket();
  clearAccessToken();
}
