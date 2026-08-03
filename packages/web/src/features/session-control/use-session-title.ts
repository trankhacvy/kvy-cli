"use client";

import type { EncryptedBox } from "@kvy/crypto/web";
import { useEffect, useState } from "react";
import type { CryptoBridgeClient } from "@/crypto";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import { useSessionCrypto } from "./use-session-crypto";

/** Same "no title yet" fallback `features/session-list/live-source.ts` uses
 * for the Home screen — one shared piece of copy for "decrypted, but the
 * metadata box carries no title" across both screens. */
const UNTITLED_SESSION = "(untitled session)";

/**
 * Decrypted session title for the timeline header — replacing the
 * previous literal `Session {sessionId}`. Structurally identical to
 * `use-session-model-chip.ts` (same DEK, same `useSyncSnapshotQuery` +
 * `useSessionCrypto` inputs, same metadata-version-gated re-decrypt), just
 * opening the box's `title` field instead of `model`.
 *
 * Returns `null` until crypto is ready and the box has been opened at least
 * once; callers fall back to something synchronously available (e.g. the
 * raw `sessionId`) for that window rather than rendering blank.
 */
export function useSessionTitle(sessionId: string): string | null {
  const bridge = useSessionCrypto(sessionId);
  const snapshot = useSyncSnapshotQuery();
  const [title, setTitle] = useState<string | null>(null);
  const [decryptedVersion, setDecryptedVersion] = useState<number | null>(null);

  const session = snapshot.data?.sessions.find((s) => s.id === sessionId) ?? null;
  const metadataVersion = session?.metadata.version ?? null;

  useEffect(() => {
    if (!bridge || !session || metadataVersion === null) return;
    if (decryptedVersion === metadataVersion) return;
    let cancelled = false;
    decryptTitle(bridge, session.metadata.value, sessionId).then((next) => {
      if (cancelled) return;
      setTitle(next);
      setDecryptedVersion(metadataVersion);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, session, metadataVersion, decryptedVersion, sessionId]);

  // Reset on session switch — same "no stale title from a previous session
  // id" rationale as `use-session-model-chip.ts`'s own reset effect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `sessionId` isn't read inside the effect body — it's the reset trigger itself (re-run, not re-derive, on session switch).
  useEffect(() => {
    setTitle(null);
    setDecryptedVersion(null);
  }, [sessionId]);

  return title;
}

async function decryptTitle(
  bridge: CryptoBridgeClient,
  box: EncryptedBox,
  sessionId: string,
): Promise<string> {
  try {
    const opened = await bridge.open<{ title?: unknown }>(box);
    if (opened && typeof opened.title === "string" && opened.title.trim().length > 0) {
      return opened.title;
    }
    return UNTITLED_SESSION;
  } catch (err) {
    console.error(`use-session-title: failed to decrypt session ${sessionId}'s metadata`, err);
    return UNTITLED_SESSION;
  }
}
