"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getSessionMessages } from "@/lib/api";
import { getToken } from "@/lib/session";
import { decryptMessageBatches, messagesQueryKey } from "@/sync";
import { type RenderItem, reduceEnvelopes } from "@/sync/reducer";
import { useSessionCrypto } from "./use-session-crypto";

/**
 * The real data source behind `SessionTimelineScreen` (plan.md §16 "§2.3
 * Permission pipeline" follow-up: "perm-request/perm-resolve envelopes into
 * the timeline" — the demo-fixture live-wiring gap). Fetches this session's
 * most recent page of encrypted message batches (`GET
 * /v1/sessions/:id/messages`), decrypts + reduces them once the session's
 * DEK has unwrapped (`useSessionCrypto`), and re-derives whenever either
 * changes.
 *
 * Live updates: a `message-new` WS update lands in the same
 * `['messages', sessionId]` query the sync engine's own fast path patches
 * (`useSessionCrypto`'s `useSyncSnapshotQuery` wires the engine up) —
 * `useInfiniteQuery` observes that cache entry directly, so a new envelope
 * flows through this hook's decrypt effect with no extra plumbing.
 *
 * Only the most recent page is fetched — older history ("load more") isn't
 * wired into `Timeline` yet, matching its current read-only, non-paginated
 * scroll container.
 */
export function useLiveRenderItems(sessionId: string): RenderItem[] {
  const crypto = useSessionCrypto(sessionId);
  const messagesQuery = useInfiniteQuery({
    queryKey: messagesQueryKey(sessionId),
    queryFn: ({ pageParam }: { pageParam: number | undefined }) => {
      const token = getToken();
      if (!token) throw new Error("Not signed in");
      return getSessionMessages(token, sessionId, pageParam);
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.nextBefore ?? undefined,
    enabled: getToken() !== null,
  });

  const [items, setItems] = useState<RenderItem[]>([]);

  // Clears immediately on a session switch so the previous session's items
  // never flash while the new session's first page is still in flight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `sessionId` isn't read inside the effect body — it's the reset trigger itself (re-run, not re-derive, on session switch).
  useEffect(() => {
    setItems([]);
  }, [sessionId]);

  useEffect(() => {
    if (!crypto || !messagesQuery.data) return;
    let cancelled = false;
    decryptMessageBatches(messagesQuery.data.pages, crypto)
      .then((envelopes) => {
        if (!cancelled) setItems(reduceEnvelopes(envelopes));
      })
      .catch((err) => {
        // `decryptMessageBatches` itself already logs + drops any individual
        // bad row (design principle: no silent failures) — this only fires
        // for a total failure (e.g. the crypto worker crashing mid-batch,
        // `client.ts`'s `rejectAllPending`), which must stay visible too
        // rather than becoming an unhandled rejection under this effect.
        if (!cancelled) {
          console.error(
            `useLiveRenderItems: failed to decrypt session ${sessionId}'s messages`,
            err,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [crypto, messagesQuery.data, sessionId]);

  return items;
}
