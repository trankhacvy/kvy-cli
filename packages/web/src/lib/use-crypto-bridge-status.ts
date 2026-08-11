"use client";

import { useCallback, useEffect, useState } from "react";
import { type CryptoBridgeClient, resolveKeyMaterial } from "@/crypto";
import { useCryptoBridge } from "./use-crypto-bridge";

export type BridgeStatus =
  | { kind: "loading" }
  /** No key material on this browser — offer to fetch it from another device. */
  | { kind: "no-keys" }
  /** A pre-Phase-5 PIN-wrapped record: one last PIN prompt upgrades it. */
  | { kind: "needs-migration" }
  /** A "prf" or "passkey" record whose passkey check was dismissed or failed. Distinct from
   * "no-keys": the keys ARE here, they just weren't unlocked, so offering to re-fetch them
   * from another device would be wrong. */
  | { kind: "locked-out" }
  | { kind: "ready"; bridge: CryptoBridgeClient };

function requestPersistentStorage(): void {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return;
  void navigator.storage.persist().catch(() => {});
}

export function useCryptoBridgeStatus(accountId: string | null): {
  status: BridgeStatus;
  refresh: () => Promise<void>;
} {
  const bridge = useCryptoBridge();
  const [status, setStatus] = useState<BridgeStatus>({ kind: "loading" });

  const evaluate = useCallback(async (): Promise<void> => {
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

    const material = await resolveKeyMaterial(stored.mode, stored.credentialId, accountId);
    if (material === null) {
      setStatus({ kind: "locked-out" });
      return;
    }

    let loaded: boolean;
    if (material.kind === "master-secret") {
      loaded = await bridge.ensureLoaded(accountId, undefined, material.masterSecret);
    } else if (material.kind === "wrap-key") {
      loaded = await bridge.ensureLoaded(accountId, material.wrapKey);
    } else {
      loaded = await bridge.ensureLoaded(accountId);
    }

    if (loaded) {
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
