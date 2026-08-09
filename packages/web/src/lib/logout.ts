/**
 * Sign-out teardown. Five steps in order:
 *
 * 0. Stop the shared crypto-bridge worker BEFORE wiping, so it can't re-open a
 *    database the wipe step is about to delete. Skips the normal 2-second release
 *    grace (that exists to survive a route change, not a sign-out).
 * 1. Wipe key material via a throwaway bridge whose `clear()` purges the shared
 *    IndexedDB store. A dedicated worker so this works regardless of what else is mounted.
 * 2. Revoke this device_sessions row server-side, while the token is still valid — otherwise
 *    it sits around looking "active" until its 60-day expiry.
 * 3. Disconnect `apiSocket` before the token disappears, so the reconnect loop never
 *    fires with null auth.
 * 4. Clear the access token last, so nothing above observes a signed-out state mid-teardown.
 *
 * Key-wipe and server-revoke failures are logged but never abort the sign-out - token
 * clear must always happen.
 */
import { createCryptoBridge } from "@/crypto";
import { revokeCurrentSession } from "@/lib/api";
import { clearToken, getToken } from "@/lib/session";
import { terminateSharedCryptoBridge } from "@/lib/use-crypto-bridge";
import { apiSocket } from "@/sync";

export interface LogoutDeps {
  stopSharedBridge: () => void;
  wipeKeyMaterial: () => Promise<void>;
  revokeSessionOnServer: () => Promise<void>;
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

async function revokeCurrentSessionOnServer(): Promise<void> {
  const token = getToken();
  if (!token) return;
  await revokeCurrentSession(token);
}

export async function logout(deps: Partial<LogoutDeps> = {}): Promise<void> {
  const stopSharedBridge = deps.stopSharedBridge ?? terminateSharedCryptoBridge;
  const wipeKeyMaterial = deps.wipeKeyMaterial ?? wipeKeyMaterialWithThrowawayBridge;
  const revokeSessionOnServer = deps.revokeSessionOnServer ?? revokeCurrentSessionOnServer;
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
  try {
    await revokeSessionOnServer();
  } catch (err) {
    console.error("logout: failed to revoke the session server-side", err);
  }
  disconnectSocket();
  clearAccessToken();
}
