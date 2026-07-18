"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getSessionMessages } from "@/lib/api";
import { getToken } from "@/lib/session";
import { decryptMessageBatches, messagesQueryKey } from "@/sync";
import { type RenderItem, reduceEnvelopes } from "@/sync/reducer";
import { formatDecryptError } from "./decrypt-error";
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
 * `error` (W1.10, plan.md §16 wave 1) surfaces a page-level decrypt failure
 * — previously only `console.error`'d — so `SessionTimelineScreen` can show
 * an inline destructive banner with a "Retry" instead of silently rendering
 * an empty/stale transcript.
 *
 * Pagination (plan-v2.md W4.2 "Load earlier" button): `hasMore`/
 * `isLoadingMore`/`loadEarlier` pass `useInfiniteQuery`'s own
 * `hasNextPage`/`isFetchingNextPage`/`fetchNextPage` straight through —
 * `getSessionMessages`'s `before` cursor (`nextBefore` on the previous page)
 * already supported paging backward, this hook just didn't expose the means
 * to trigger it yet. `decryptMessageBatches`/`reduceEnvelopes` don't care
 * about page order (see `messages.ts`'s own doc comment), so a newly-fetched
 * older page decrypts and merges in with no special-casing here.
 *
 * `isInitialLoading` (plan-v2.md W4.2 "skeletons for … timeline initial
 * loads") is `messagesQuery.isLoading` — TanStack's own "no data cached yet
 * and a fetch is in flight" signal — straight through, so
 * `SessionTimelineScreen` can show a transcript skeleton instead of a bare
 * empty list for the one render or two before the first page (and this
 * session's DEK) resolve.
 */
export function useLiveRenderItems(sessionId: string): {
  items: RenderItem[];
  error: string | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  isInitialLoading: boolean;
  loadEarlier: () => void;
} {
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
  const [error, setError] = useState<string | null>(null);

  // Clears immediately on a session switch so the previous session's items
  // (and any stale error banner) never flash while the new session's first
  // page is still in flight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `sessionId` isn't read inside the effect body — it's the reset trigger itself (re-run, not re-derive, on session switch).
  useEffect(() => {
    setItems([]);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!crypto || !messagesQuery.data) return;
    let cancelled = false;
    decryptMessageBatches(messagesQuery.data.pages, crypto)
      .then((envelopes) => {
        if (!cancelled) {
          setItems(reduceEnvelopes(envelopes));
          setError(null);
        }
      })
      .catch((err) => {
        // `decryptMessageBatches` itself already logs + drops any individual
        // bad row (design principle: no silent failures) — this only fires
        // for a total failure (e.g. the crypto worker crashing mid-batch,
        // `client.ts`'s `rejectAllPending`), which must stay visible too
        // rather than becoming an unhandled rejection under this effect —
        // and, per W1.10, in the UI itself rather than only the console.
        if (!cancelled) {
          console.error(
            `useLiveRenderItems: failed to decrypt session ${sessionId}'s messages`,
            err,
          );
          setError(formatDecryptError(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [crypto, messagesQuery.data, sessionId]);

  return {
    items,
    error,
    hasMore: messagesQuery.hasNextPage,
    isLoadingMore: messagesQuery.isFetchingNextPage,
    isInitialLoading: messagesQuery.isLoading,
    loadEarlier: () => {
      void messagesQuery.fetchNextPage();
    },
  };
}
