"use client";

import type { Ephemeral } from "@kvy/wire";
import { useEffect, useRef, useState } from "react";
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

/** A `working:true` ephemeral older than this with no successor is treated
 * as stale. Ephemerals are droppable by design (§4.3) — a `working:true`
 * that never gets a matching `working:false` (daemon crash, dropped socket
 * message, etc.) must not pin the "Working…" indicator on forever (W1.7). */
export const WORKING_STALE_MS = 60_000;

/** Whether a `working:true` signal received at `workingSince` is still
 * fresh as of `now`. `workingSince === null` means no `working:true` is
 * currently pending (already not-working). */
export function isWorkingFresh(workingSince: number | null, now: number): boolean {
  return workingSince !== null && now - workingSince < WORKING_STALE_MS;
}

/** Subscribes to the live `ephemeral` stream for one session's `activity`/
 * `attention` signals (kvy-system-design.md §4.3, plan.md §16 "2.4 Web
 * control surface"). Resets to `INITIAL_STATE` whenever `sessionId` changes
 * so switching sessions doesn't carry over a stale "working"/attention flag
 * from whatever was previously open. */
export function useSessionEphemerals(
  sessionId: string,
  source: EphemeralSource = apiSocket,
): SessionEphemeralState {
  const [state, setState] = useState<SessionEphemeralState>(INITIAL_STATE);
  const workingSinceRef = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `source` is a stable singleton by default (apiSocket) or a test double the caller controls — re-subscribing only on sessionId change is intentional.
  useEffect(() => {
    setState(INITIAL_STATE);
    workingSinceRef.current = null;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;

    const clearStaleTimer = () => {
      if (staleTimer !== undefined) {
        clearTimeout(staleTimer);
        staleTimer = undefined;
      }
    };

    const unsubscribe = source.on("ephemeral", (event) => {
      if (event.t === "activity" && event.sessionId === sessionId) {
        clearStaleTimer();
        workingSinceRef.current = event.working ? Date.now() : null;
        setState((prev) => ({ ...prev, working: event.working }));
        // No successor within WORKING_STALE_MS ⇒ this "working" was dropped
        // somewhere upstream (crash, missed socket message); stop trusting it.
        if (event.working) {
          staleTimer = setTimeout(() => {
            if (!isWorkingFresh(workingSinceRef.current, Date.now())) {
              setState((prev) => ({ ...prev, working: false }));
            }
          }, WORKING_STALE_MS);
        }
      } else if (event.t === "attention" && event.sessionId === sessionId) {
        setState((prev) => ({ ...prev, attentionKind: event.kind }));
      }
    });

    return () => {
      clearStaleTimer();
      unsubscribe();
    };
  }, [sessionId]);

  return state;
}
