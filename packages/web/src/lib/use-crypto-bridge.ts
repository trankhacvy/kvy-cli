"use client";

import { useEffect, useRef, useState } from "react";
import { type CryptoBridgeClient, createCryptoBridge } from "@/crypto";

/**
 * A single crypto-bridge worker, shared for as long as at least one component
 * has it mounted, refcounted rather than one-per-mount. issue-4-plan.md
 * §6.1/§6.4: unlocking the worker (`bridge.unlock(pin)`) derives the key tree
 * in THAT worker's own memory only — a second, independent worker instance
 * would come up locked again and need its own PIN prompt. Since many
 * unrelated features each call `useCryptoBridge()` on their own
 * (`use-session-crypto.ts`, `use-machine-crypto.ts`, the settings dialog,
 * …), sharing one instance across all of them (while any of them is mounted)
 * means the user unlocks once per page-load, not once per feature.
 *
 * Teardown is debounced (`RELEASE_GRACE_MS`), not immediate: a client-side
 * route change unmounts the old page's tree and mounts the new one as two
 * separate React commits, so refCount can genuinely (if briefly) hit 0
 * between them even though this is still "the same page load" — e.g.
 * `password/page.tsx` redirecting to `/` right after `bridge.init(...)`
 * unlocked it. Tearing down immediately on that transient zero would
 * silently re-lock the bridge for the very next page, defeating the "stays
 * authenticated across navigation" guarantee. A full page reload, in
 * contrast, always wipes this module's state outright (new JS realm), which
 * is exactly the "reload requires PIN unlock" behavior issue-4-plan.md §6.1
 * calls for — the grace window only smooths over same-load navigations.
 */
let sharedBridge: CryptoBridgeClient | null = null;
let refCount = 0;
let unlocked = false;
let pendingTerminate: ReturnType<typeof setTimeout> | null = null;

// Comfortably longer than a React route transition's unmount->remount gap
// (typically well under a tick) without being so long that a genuine
// "nothing on this page needs crypto anymore" case keeps a worker alive
// pointlessly for very long.
const RELEASE_GRACE_MS = 2000;

function cancelPendingTerminate(): void {
  if (pendingTerminate) {
    clearTimeout(pendingTerminate);
    pendingTerminate = null;
  }
}

function acquire(): CryptoBridgeClient {
  cancelPendingTerminate();
  if (!sharedBridge) {
    sharedBridge = createCryptoBridge();
    unlocked = false;
  }
  refCount += 1;
  return sharedBridge;
}

function release(instance: CryptoBridgeClient): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount !== 0 || sharedBridge !== instance) return;
  cancelPendingTerminate();
  pendingTerminate = setTimeout(() => {
    pendingTerminate = null;
    // Only tear down if nothing re-acquired during the grace window.
    if (refCount === 0 && sharedBridge === instance) {
      instance.terminate();
      sharedBridge = null;
      unlocked = false;
    }
  }, RELEASE_GRACE_MS);
}

export function useCryptoBridge(): CryptoBridgeClient | null {
  const [bridge, setBridge] = useState<CryptoBridgeClient | null>(null);
  const bridgeRef = useRef<CryptoBridgeClient | null>(null);

  useEffect(() => {
    const acquired = acquire();
    bridgeRef.current = acquired;
    setBridge(acquired);
    return () => {
      release(acquired);
      if (bridgeRef.current === acquired) {
        bridgeRef.current = null;
      }
    };
  }, []);

  return bridge;
}

/** Whether the shared bridge (if any) has been unlocked this page-load. */
export function isCryptoBridgeUnlocked(): boolean {
  return sharedBridge !== null && unlocked;
}

/**
 * A "peek" accessor for code outside the component tree (`lib/session.ts`'s
 * `silentRefresh`, `sync/apiSocket.ts`'s proactive renew) that needs to make a one-off
 * call against an already-live, already-unlocked bridge without participating in its
 * mount/unmount lifecycle — unlike `useCryptoBridge()`, this never creates one, never
 * increments the refcount, and returns `null` outright if the shared instance isn't
 * currently unlocked (there is nothing safe to call `refreshSession()` against
 * otherwise: the refresh token only exists PIN-recovered in an unlocked worker's
 * memory). Relies on `RequireAuth`/the protected layout keeping at least one
 * `useCryptoBridge()` consumer mounted for as long as the user is inside the app —
 * true by construction, since that's the same gate this instance's unlock came from.
 */
export function getSharedCryptoBridge(): CryptoBridgeClient | null {
  return sharedBridge && unlocked ? sharedBridge : null;
}

/** Call after a successful `bridge.init(...)` or `bridge.unlock(pin)` — marks
 * every other mounted consumer of the shared bridge as unlocked too, since
 * they're all the same worker instance. */
export function markCryptoBridgeUnlocked(): void {
  unlocked = true;
}

/** Logout / explicit lock: forces the next `isCryptoBridgeUnlocked()` check
 * to fail even if the underlying worker instance is still alive (e.g. other
 * components stay mounted through a sign-out redirect). */
export function markCryptoBridgeLocked(): void {
  unlocked = false;
}
