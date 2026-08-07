"use client";

import { useCallback, useEffect, useState } from "react";
import { type CryptoBridgeClient, resolveWrapKeyForRecord } from "@/crypto";
import { useCryptoBridge } from "./use-crypto-bridge";

export type BridgeStatus =
  | { kind: "loading" }
  /** No key material on this browser — offer to fetch it from another device. */
  | { kind: "no-keys" }
  /** A pre-Phase-5 PIN-wrapped record: one last PIN prompt upgrades it. */
  | { kind: "needs-migration" }
  /** A "prf" record whose passkey check was dismissed or failed. Distinct from "no-keys":
   * the keys ARE here, they just weren't unlocked, so offering to re-fetch them from
   * another device would be wrong. */
  | { kind: "locked-out" }
  | { kind: "ready"; bridge: CryptoBridgeClient };

/**
 * Best-effort request that the browser not evict this origin's IndexedDB under storage
 * pressure — without it, the wrapped key `key-storage.ts` persists there is "best-effort"
 * storage a browser (Safari/WebKit especially, including installed home-screen PWAs) can
 * silently clear, which reads to the user as "I keep getting asked to re-approve this
 * device" even though they never signed out. Safe to call every time the bridge becomes
 * ready — already-granted persistence is a harmless no-op, and a browser without the API
 * (or one that denies the request) just keeps today's behavior.
 */
function requestPersistentStorage(): void {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return;
  void navigator.storage.persist().catch(() => {});
}

/**
 * The unlock state machine every key-dependent surface needs.
 *
 * Readiness comes from `describeStorage()` + `ensureLoaded()`, NOT from `getIdentity()`:
 * identity reads plaintext public keys (which a v1 record still has), so a not-yet-migrated
 * browser would falsely report "ready" over a worker that can decrypt nothing.
 *
 * `accountId` scopes both calls - without it, a browser holding ANY account's key material
 * reports "ready" regardless of which account is signed in, silently loading the wrong tree.
 */
export function useCryptoBridgeStatus(accountId: string | null): {
  status: BridgeStatus;
  refresh: () => Promise<void>;
} {
  const bridge = useCryptoBridge();
  const [status, setStatus] = useState<BridgeStatus>({ kind: "loading" });

  const evaluate = useCallback(async (): Promise<void> => {
    // No account id yet means no session yet — evaluating now would answer "are there keys
    // here" without being able to ask "whose". Stay `loading`; `RequireAuth` renders nothing
    // until `sessionReady` anyway, and re-runs this the moment the id appears.
    if (!bridge || !accountId) return;
    const stored = await bridge.describeStorage(accountId);
    if (!stored.present) {
      setStatus({ kind: "no-keys" });
      return;
    }
    if (stored.version === 1) {
      setStatus({ kind: "needs-migration" });
      return;
    }

    // A "prf" record's wrap key comes from a passkey, and WebAuthn is main-thread only —
    // so derive it here (prompting for the biometric) and hand the handle to the worker.
    const wrapKey = await resolveWrapKeyForRecord(stored.mode, stored.credentialId);
    if (wrapKey === null) {
      setStatus({ kind: "locked-out" });
      return;
    }

    if (await bridge.ensureLoaded(accountId, wrapKey)) {
      requestPersistentStorage();
      setStatus({ kind: "ready", bridge });
    } else {
      setStatus({ kind: "no-keys" });
    }
  }, [bridge, accountId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await evaluate();
    })();
    return () => {
      cancelled = true;
    };
  }, [evaluate]);

  return { status, refresh: evaluate };
}
