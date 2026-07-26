"use client";

import { useEffect, useRef, useState } from "react";
import { type CryptoBridgeClient, createCryptoBridge } from "@/crypto";

/**
 * A single crypto-bridge worker, shared for as long as at least one component has it
 * mounted, refcounted rather than one-per-mount. Many unrelated features each call
 * `useCryptoBridge()` on their own, so sharing one instance keeps a single worker (and a
 * single set of in-memory keys) per page load.
 *
 * Teardown is debounced (`RELEASE_GRACE_MS`), not immediate: a client-side route change
 * unmounts the old page's tree and mounts the new one as two separate React commits, so
 * refCount can genuinely (if briefly) hit 0 between them even though this is still the
 * same page load.
 *
 * docs/auth-ux-overhaul-plan.md Phase 5: there is no `unlocked` flag any more. A fresh
 * worker loads its own key material via `ensureLoaded()` with no PIN, so "is this worker
 * usable" is a question for `useCryptoBridgeStatus()`, not a module-level boolean.
 */
let sharedBridge: CryptoBridgeClient | null = null;
let refCount = 0;
let pendingTerminate: ReturnType<typeof setTimeout> | null = null;

const RELEASE_GRACE_MS = 2000;

function cancelPendingTerminate(): void {
  if (pendingTerminate) {
    clearTimeout(pendingTerminate);
    pendingTerminate = null;
  }
}

function acquire(): CryptoBridgeClient {
  cancelPendingTerminate();
  if (!sharedBridge) sharedBridge = createCryptoBridge();
  refCount += 1;
  return sharedBridge;
}

function release(instance: CryptoBridgeClient): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount !== 0 || sharedBridge !== instance) return;
  cancelPendingTerminate();
  pendingTerminate = setTimeout(() => {
    pendingTerminate = null;
    if (refCount === 0 && sharedBridge === instance) {
      instance.terminate();
      sharedBridge = null;
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
      if (bridgeRef.current === acquired) bridgeRef.current = null;
    };
  }, []);

  return bridge;
}

/**
 * A crypto-bridge worker dedicated to the calling component's lifetime, never shared
 * with any other caller — the pre-refactor `useCryptoBridge()` behavior (see this
 * module's git history at commit 6505233), restored as its own hook.
 *
 * Required by any hook that calls `setSessionKey()` and reads it back later via
 * `open`/`seal`/`sealBlob`/`openBlob`: the worker holds the unwrapped DEK in a single
 * mutable slot (`crypto/worker-handler.ts`'s `activeDek`), so two callers sharing one
 * worker can have one caller's `setSessionKey` for session A land between another
 * caller's `setSessionKey`+`open` for session B, decrypting B's data under A's key —
 * confirmed as the root cause of `docs/auth-ux-post-verification-fixes.md`'s Bug A
 * (messages silently failing to decrypt after Fix 3's re-pair, actually unrelated to
 * re-pairing at all: `useCryptoBridge()`'s shared singleton, introduced by 994846a for
 * memory/perf, silently broke every caller's own "this worker is isolated" assumption,
 * several of which say so explicitly in now-stale doc comments — e.g.
 * `features/session-list/live-source.ts`'s `titlesBridge`/`itemsBridge`).
 *
 * `useCryptoBridge()`'s shared singleton stays the default for stateless, one-shot
 * callers (auth pages' `getIdentity`/`init`/`bindKeysProof`, and `getSharedCryptoBridge()`
 * for session refresh) that never hold an ambient active key across time and were never
 * at risk from sharing.
 */
export function useDedicatedCryptoBridge(): CryptoBridgeClient | null {
  const [bridge, setBridge] = useState<CryptoBridgeClient | null>(null);
  const bridgeRef = useRef<CryptoBridgeClient | null>(null);

  useEffect(() => {
    const created = createCryptoBridge();
    bridgeRef.current = created;
    setBridge(created);
    return () => {
      created.terminate();
      if (bridgeRef.current === created) bridgeRef.current = null;
    };
  }, []);

  return bridge;
}

/**
 * Tear the shared worker down NOW, skipping `release()`'s 2-second grace. Logout only —
 * that grace exists so a client-side route change doesn't churn the worker, which is the
 * opposite of what sign-out wants: a worker still holding the unwrapped key tree in
 * memory, and still able to re-create the IndexedDB databases logout just deleted, is
 * exactly the residue `crypto/key-storage.ts`'s/`session-storage.ts`'s `destroy()` exists
 * to remove (auth-ux-overhaul-e2e-results.md E2E-5.5).
 */
export function terminateSharedCryptoBridge(): void {
  cancelPendingTerminate();
  const instance = sharedBridge;
  sharedBridge = null;
  refCount = 0;
  instance?.terminate();
}

/**
 * A "peek" accessor for code outside the component tree (`lib/session.ts`'s
 * `silentRefresh`, `sync/apiSocket.ts`'s proactive renew) that needs a one-off call
 * against an already-live bridge without participating in its mount/unmount lifecycle.
 *
 * Phase 4a: this used to return null unless the worker was unlocked, because the refresh
 * token only existed inside the PIN-wrapped key record. The session credential lives in
 * its own store now, so refreshing works regardless of key state — which is exactly what
 * lets a keyless browser stay signed in long enough to ask for keys.
 */
export function getSharedCryptoBridge(): CryptoBridgeClient | null {
  return sharedBridge;
}
