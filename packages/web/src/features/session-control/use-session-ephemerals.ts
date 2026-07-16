"use client";

import type { Ephemeral } from "@falcon/wire";
import { useEffect, useState } from "react";
import type { AttentionKind } from "@/features/session-list/types";
import { apiSocket } from "@/sync";

export interface SessionEphemeralState {
  /** Live "thinking" indicator (design §4.3's `activity` ephemeral) — droppable/
   * coalesced, so this is a UI nicety, never something correctness depends on. */
  working: boolean;
  /** The server's `attention` ephemeral for this session, or `null` if none has
   * arrived yet this session — see `attention.ts`'s `deriveAttention` for how
   * this combines with the reduced transcript. */
  attentionKind: AttentionKind | null;
}

/** The narrow slice of `apiSocket` this hook needs — real `apiSocket`
 * (`@/sync`) satisfies this structurally; tests can pass an in-memory
 * double instead (mirrors `apiSocket.ts`'s own testable-seam pattern). */
export interface EphemeralSource {
  on(event: "ephemeral", handler: (e: Ephemeral) => void): () => void;
}

const INITIAL_STATE: SessionEphemeralState = { working: false, attentionKind: null };

/** Subscribes to the live `ephemeral` stream for one session's `activity`/
 * `attention` signals (falcon-system-design.md §4.3, plan.md §16 "2.4 Web
 * control surface"). Resets to `INITIAL_STATE` whenever `sessionId` changes
 * so switching sessions doesn't carry over a stale "working"/attention flag
 * from whatever was previously open. */
export function useSessionEphemerals(
  sessionId: string,
  source: EphemeralSource = apiSocket,
): SessionEphemeralState {
  const [state, setState] = useState<SessionEphemeralState>(INITIAL_STATE);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `source` is a stable singleton by default (apiSocket) or a test double the caller controls — re-subscribing only on sessionId change is intentional.
  useEffect(() => {
    setState(INITIAL_STATE);
    return source.on("ephemeral", (event) => {
      if (event.t === "activity" && event.sessionId === sessionId) {
        setState((prev) => ({ ...prev, working: event.working }));
      } else if (event.t === "attention" && event.sessionId === sessionId) {
        setState((prev) => ({ ...prev, attentionKind: event.kind }));
      }
    });
  }, [sessionId]);

  return state;
}
