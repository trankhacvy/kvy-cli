"use client";

import { decodeBase64 } from "@kvy/crypto/web";
import { useEffect, useState } from "react";
import type { CryptoBridgeClient } from "@/crypto";
import { useDedicatedCryptoBridge } from "./use-crypto-bridge";
import { useSyncSnapshotQuery } from "./use-sync-snapshot";

/**
 * Unwraps `machineId`'s data-encryption key into a fresh crypto-bridge
 * worker — the machine-scoped counterpart to `features/session-control/
 * use-session-crypto.ts` (mirrors its shape exactly: `MachineRow.dek` is the
 * same opaque sealed-box wrap convention as `SessionRow.dek`,
 * `sync/machineRpc.ts`'s own doc comment). `null` until the machine's row
 * has synced *and* `setSessionKey` has resolved `true`.
 *
 * Lives in `lib/` rather than under any one `features/` directory because
 * two feature areas need it — `features/new-session` (spawn/browse against
 * the chosen machine before any session exists yet) and `features/git-diff`
 * (git.status/git.diff against a session's owning machine) — the same
 * reasoning `use-sync-snapshot.ts`'s own doc comment gives for why it was
 * extracted out of `features/session-control` and into here once a second
 * feature needed it: there should be exactly one place that owns this.
 */
export function useMachineCrypto(machineId: string): CryptoBridgeClient | null {
  const bridge = useDedicatedCryptoBridge();
  const snapshot = useSyncSnapshotQuery();
  const [ready, setReady] = useState(false);

  const dek = snapshot.data?.machines.find((m) => m.id === machineId)?.dek ?? null;

  useEffect(() => {
    setReady(false);
    if (!bridge || dek === null) return;
    let cancelled = false;
    bridge
      .setSessionKey(decodeBase64(dek))
      .then((ok) => {
        if (cancelled) return;
        if (!ok) {
          console.error(`useMachineCrypto: machine ${machineId}'s DEK failed to unwrap`);
        }
        setReady(ok);
      })
      .catch((err) => {
        // A rejected (not just `false`-resolved) `setSessionKey` call means
        // the worker itself errored/crashed mid-call (`client.ts`'s
        // `rejectAllPending`) — still visible (design principle: no silent
        // failures), not just an unhandled rejection swallowed by the effect.
        if (cancelled) return;
        console.error(`useMachineCrypto: machine ${machineId}'s setSessionKey call failed`, err);
        setReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, dek, machineId]);

  return ready ? bridge : null;
}
