/**
 * Sign-out teardown. Four steps in order:
 *
 * 0. Stop the shared crypto-bridge worker BEFORE wiping, so it can't re-open a
 *    database the wipe step is about to delete. Skips the normal 2-second release
 *    grace (that exists to survive a route change, not a sign-out).
 * 1. Wipe key material via a throwaway bridge whose `clear()` purges the shared
 *    IndexedDB store. A dedicated worker so this works regardless of what else is mounted.
 * 2. Disconnect `apiSocket` before the token disappears, so the reconnect loop never
 *    fires with null auth.
 * 3. Clear the access token last, so nothing above observes a signed-out state mid-teardown.
 *
 * Key-wipe failures are logged but never abort the sign-out - token clear must always happen.
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
