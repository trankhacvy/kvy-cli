"use client";

import { decodeBase64 } from "@kvy/crypto/web";
import type { EncryptedBox } from "@kvy/wire";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { CryptoBridgeClient } from "@/crypto";
import { putSessionMetadataCas } from "@/lib/api";
import { getToken } from "@/lib/session";
import { useDedicatedCryptoBridge } from "@/lib/use-crypto-bridge";
import type { SyncSnapshot } from "@/sync";
import { syncQueryKey } from "@/sync";

/**
 * The web's first encrypted-metadata WRITE path — Rename and Pin
 * both go through this one CAS-retry mutation. Every prior web write to a
 * session touches only plaintext columns (archive/delete/status); this is
 * the first one that has to open the current box, patch it, and re-seal
 * under the per-session DEK, exactly like `cli/src/api/sessionMetadata.ts`'s
 * `updateModel` already does server-side of a different field.
 *
 * A FUNCTIONAL patch — `(current) => nextValue` — rather than a plain
 * object, so Pin can toggle without the caller having to already know the
 * current value, and so every caller (even one racing a concurrent write)
 * always patches the freshest opened plaintext, never a stale snapshot.
 */
export type SessionMetadataPatch = (current: Record<string, unknown>) => Record<string, unknown>;

export interface SessionMetadataWriteResult {
  value: EncryptedBox;
  version: number;
}

const MAX_ATTEMPTS = 5;

/**
 * The CAS-retry core, deliberately split out from the hook below so tests
 * can drive it with a real (loopback-worker-backed) crypto bridge instead of
 * needing `useDedicatedCryptoBridge`'s mount effect to fire — the same split
 * `features/git-diff/live-actions.ts` uses relative to its
 * `use-live-git-diff-actions.ts` hook wrapper.
 *
 * Never starts from `{}` on an unopenable box — a decrypt failure throws
 * visibly instead of silently sealing over (and clobbering) a title/pin it
 * failed to read, per this codebase's "no silent data loss" principle
 * (`@kvy/crypto`'s `open()` doc comment).
 */
export async function patchSessionMetadataCas(
  deps: {
    bridge: CryptoBridgeClient;
    putCas: typeof putSessionMetadataCas;
    token: string;
    sessionId: string;
    /** Base64 wrapped DEK (`SessionRow.dek`) — same opaque sealed-box wrap
     * convention `use-machine-crypto.ts` unwraps for machines. */
    dek: string;
  },
  initial: { value: EncryptedBox; version: number },
  patch: SessionMetadataPatch,
): Promise<SessionMetadataWriteResult> {
  const unwrapped = await deps.bridge.setSessionKey(decodeBase64(deps.dek));
  if (!unwrapped) {
    throw new Error("Could not unwrap this session's key.");
  }

  let current = initial;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const opened = await deps.bridge.open<Record<string, unknown>>(current.value);
    if (!opened) {
      throw new Error("Could not decrypt this session's metadata.");
    }
    const patched = patch(opened);
    const sealed = await deps.bridge.seal(patched);
    const result = await deps.putCas(deps.token, deps.sessionId, {
      expectedVersion: current.version,
      value: sealed,
    });
    if (result.ok) {
      return { value: sealed, version: result.version };
    }
    if (!result.current.value) {
      // No box at all server-side to re-open against — nothing to converge
      // with, so looping again would just re-derive the same dead end.
      throw new Error("This session's metadata is missing server-side.");
    }
    current = { value: result.current.value, version: result.current.version };
  }
  throw new Error("Could not save: too many conflicting writes. Try again.");
}

/**
 * `useSessionMetadataPatchMutation(sessionId)` — Rename/Pin's shared
 * mutation hook. Reads the session's current `{dek, metadata}` off the
 * `['sync']` TanStack cache (kept current by the sync engine), uses its OWN
 * `useDedicatedCryptoBridge()` worker (never shared with `live-source.ts`'s
 * title/item-decryption bridges — a worker only ever holds one active
 * session key at once), and on success patches the `['sync']` cache's row so
 * `useDecryptedTitles`/`useSessionTitle` (both `metadata.version`-gated)
 * re-decrypt everywhere with no extra invalidation — the WS `session-update`
 * fan-out reconciles moments later to the same state.
 */
export function useSessionMetadataPatchMutation(sessionId: string) {
  const queryClient = useQueryClient();
  const bridge = useDedicatedCryptoBridge();

  return useMutation({
    mutationFn: async (patch: SessionMetadataPatch): Promise<SessionMetadataWriteResult> => {
      const token = getToken();
      if (!token) throw new Error("Not signed in");
      if (!bridge) throw new Error("Crypto bridge isn't ready yet. Try again in a moment.");

      const snapshot = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
      const session = snapshot?.sessions.find((s) => s.id === sessionId);
      if (!session) throw new Error("Session not found.");

      return patchSessionMetadataCas(
        { bridge, putCas: putSessionMetadataCas, token, sessionId, dek: session.dek },
        { value: session.metadata.value, version: session.metadata.version },
        patch,
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData<SyncSnapshot>(syncQueryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          sessions: old.sessions.map((s) =>
            s.id === sessionId
              ? { ...s, metadata: { value: result.value, version: result.version } }
              : s,
          ),
        };
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not save changes.");
    },
  });
}
