"use client";

import type { EncryptedBox } from "@kvy/crypto/web";
import { useEffect, useState } from "react";
import type { CryptoBridgeClient } from "@/crypto";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import { useSessionCrypto } from "./use-session-crypto";

/**
 * Display-only "model" chip for the session header, sourced from session
 * metadata once the CLI records it there. Reuses
 * `useSessionCrypto`'s already-unwrapped DEK — the exact key
 * `bootstrapSession` seals `{title, path, providerSessionId, model}` under
 * (`session/bootstrap.ts`) — to open this session's own `metadata` box out
 * of the account snapshot (`useSyncSnapshotQuery`, the same `['sync']` cache
 * `features/session-list/live-source.ts`'s title decryption reads).
 *
 * Returns `null` whenever there's nothing to show: crypto not ready yet, the
 * session row hasn't synced, decryption failed, or — the common case for any
 * session started before the CLI recorded a model — the metadata box simply
 * has no `model` field. A missing chip is never treated as an error; this is
 * pure decoration on top of the header, not load-bearing state.
 */
export function useSessionModelChip(sessionId: string): string | null {
  const bridge = useSessionCrypto(sessionId);
  const snapshot = useSyncSnapshotQuery();
  const [model, setModel] = useState<string | null>(null);
  const [decryptedVersion, setDecryptedVersion] = useState<number | null>(null);

  const session = snapshot.data?.sessions.find((s) => s.id === sessionId) ?? null;
  const metadataVersion = session?.metadata.version ?? null;

  useEffect(() => {
    if (!bridge || !session || metadataVersion === null) return;
    if (decryptedVersion === metadataVersion) return;
    let cancelled = false;
    decryptModel(bridge, session.metadata.value, sessionId).then((next) => {
      if (cancelled) return;
      setModel(next);
      setDecryptedVersion(metadataVersion);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, session, metadataVersion, decryptedVersion, sessionId]);

  // Reset once this session's own metadata version regresses out from under
  // us (shouldn't happen in practice, but a stale `model` from a previous
  // session id must never linger — same "no silent stale data" principle
  // `use-live-render-items.ts`'s session-switch reset follows).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `sessionId` isn't read inside the effect body — it's the reset trigger itself (re-run, not re-derive, on session switch).
  useEffect(() => {
    setModel(null);
    setDecryptedVersion(null);
  }, [sessionId]);

  return model;
}

async function decryptModel(
  bridge: CryptoBridgeClient,
  box: EncryptedBox,
  sessionId: string,
): Promise<string | null> {
  try {
    const opened = await bridge.open<{ model?: unknown }>(box);
    if (opened && typeof opened.model === "string" && opened.model.trim().length > 0) {
      return opened.model;
    }
    return null;
  } catch (err) {
    console.error(`use-session-model-chip: failed to decrypt session ${sessionId}'s metadata`, err);
    return null;
  }
}
