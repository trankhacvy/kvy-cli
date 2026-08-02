"use client";

import { useEffect, useRef, useState } from "react";
import { type CryptoBridgeClient, createCryptoBridge } from "@/crypto";

/**
 * A single crypto-bridge worker, shared for as long as at least one component has it
 * mounted, refcounted rather than one-per-mount.
 *
 * Teardown is debounced (`RELEASE_GRACE_MS`): a client-side route change unmounts the old
 * page and mounts the new one as two separate React commits, so refCount can briefly hit 0
 * between them within the same page load.
 *
 * There is no `unlocked` flag. A fresh worker loads key material via `ensureLoaded()`,
 * so "is this worker usable" is a question for `useCryptoBridgeStatus()`.
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
 * A crypto-bridge worker dedicated to the calling component's lifetime, never shared.
 *
 * Required by any hook that calls `setSessionKey()` and reads it back via `open`/`seal`/etc:
 * the worker holds the unwrapped DEK in a single mutable `activeDek` slot, so two callers
 * sharing one worker can have one caller's `setSessionKey` for session A land between
 * another caller's `setSessionKey`+`open` for session B, silently decrypting B's data
 * under A's key.
 *
 * `useCryptoBridge()`'s shared singleton remains the default for stateless one-shot callers
 * (auth pages' `getIdentity`/`init`/`bindKeysProof`, `getSharedCryptoBridge()` for refresh)
 * that never hold an ambient active key and were never at risk from sharing.
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
 * Tears the shared worker down immediately, skipping the 2-second grace. Logout only -
 * a worker still holding the unwrapped key tree and able to re-create IndexedDB stores
 * that logout just deleted is exactly the residue `destroy()` exists to prevent.
 */
export function terminateSharedCryptoBridge(): void {
  cancelPendingTerminate();
  const instance = sharedBridge;
  sharedBridge = null;
  refCount = 0;
  instance?.terminate();
}

/**
 * A "peek" accessor for code outside the component tree that needs a one-off call against
 * an already-live bridge without participating in its mount/unmount lifecycle. The session
 * credential lives in its own store, so this works regardless of key state - a keyless
 * browser can still refresh its session.
 */
export function getSharedCryptoBridge(): CryptoBridgeClient | null {
  return sharedBridge;
}
