"use client";

import { useEffect, useState } from "react";
import type { CryptoBridgeClient } from "@/crypto";
import {
  isCryptoBridgeUnlocked,
  markCryptoBridgeUnlocked,
  useCryptoBridge,
} from "./use-crypto-bridge";

export type UnlockedBridgeStatus =
  | { kind: "loading" }
  /** No identity provisioned on this device at all (a genuinely new browser). */
  | { kind: "no-identity" }
  /** An identity is provisioned, but this page-load's crypto worker hasn't been
   * unlocked yet — issue-4-plan.md §6.1/§6.4's "reload requires a PIN" gate. */
  | { kind: "needs-unlock" }
  | { kind: "ready"; bridge: CryptoBridgeClient };

/**
 * Wraps `useCryptoBridge()` with the PIN-unlock state machine every auth-gated surface
 * needs (issue-4-plan.md §6.1/§6.4): a fresh page load always starts locked (a fresh
 * crypto-worker instance, see `use-crypto-bridge.ts`'s shared-singleton doc comment),
 * so callers render a PIN prompt until `unlock(pin)` succeeds, then get the same
 * `bridge` back as `getIdentity`/`setSessionKey`/etc. already assume.
 */
export function useUnlockedCryptoBridge(): {
  status: UnlockedBridgeStatus;
  unlock: (pin: string) => Promise<boolean>;
} {
  const bridge = useCryptoBridge();
  const [status, setStatus] = useState<UnlockedBridgeStatus>({ kind: "loading" });

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;

    (async () => {
      if (isCryptoBridgeUnlocked()) {
        if (!cancelled) setStatus({ kind: "ready", bridge });
        return;
      }
      const identity = await bridge.getIdentity();
      if (cancelled) return;
      setStatus(identity ? { kind: "needs-unlock" } : { kind: "no-identity" });
    })();

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  async function unlock(pin: string): Promise<boolean> {
    if (!bridge) return false;
    const ok = await bridge.unlock(pin);
    if (ok) {
      markCryptoBridgeUnlocked();
      setStatus({ kind: "ready", bridge });
    }
    return ok;
  }

  return { status, unlock };
}
