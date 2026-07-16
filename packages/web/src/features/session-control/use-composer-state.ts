"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { RenderItem } from "@/sync/reducer";
import {
  buildMessageEnvelope,
  type PendingMessage,
  pendingToRenderItem,
  reconcilePending,
} from "./optimistic-composer";
import { useSessionControl } from "./session-control-context";

export interface ComposerState {
  /** `items` with every still-unreconciled pending send appended (design
   * §9.1: "optimistic timeline insert reconciled by echo update"). Feed this
   * to `Timeline`, not the raw `items` prop. */
  mergedItems: RenderItem[];
  send(text: string): void;
  isSending: boolean;
  /** True while the most recently sent message is queued behind the agent's
   * current turn (the `message` RPC's own `{queued: boolean}` result). */
  isQueued: boolean;
  error: string | null;
}

/**
 * The `Composer`'s TanStack Query mutation (falcon-system-design.md §9.1;
 * plan.md §16 "2.4 Web control surface": "TanStack Query mutation calling
 * session RPC `message`"), factored out of the component so `Timeline` and
 * `Composer` can share the same merged/reconciled item list without lifting
 * a `useMutation` call through props. On failure the optimistic entry is
 * dropped — a failed send never lingers as a lie in the transcript.
 */
export function useComposerState(items: RenderItem[]): ComposerState {
  const { actions } = useSessionControl();
  const [pending, setPending] = useState<PendingMessage[]>([]);

  // Drop any pending entry once the real echo has landed in `items`.
  useEffect(() => {
    setPending((prev) => reconcilePending(prev, items));
  }, [items]);

  const mutation = useMutation({
    mutationFn: async (text: string) => {
      const envelope = buildMessageEnvelope(text);
      const localId = envelope.id;
      setPending((prev) => [...prev, { localId, text, sentAt: envelope.time, queued: false }]);
      try {
        const result = await actions.sendMessage(envelope);
        if (result.queued) {
          setPending((prev) =>
            prev.map((p) => (p.localId === localId ? { ...p, queued: true } : p)),
          );
        }
        return result;
      } catch (error) {
        setPending((prev) => prev.filter((p) => p.localId !== localId));
        throw error;
      }
    },
  });

  return {
    mergedItems: [...items, ...pending.map(pendingToRenderItem)],
    send: (text) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      mutation.mutate(trimmed);
    },
    isSending: mutation.isPending,
    isQueued: pending.some((p) => p.queued),
    error:
      mutation.status === "error"
        ? mutation.error instanceof Error
          ? mutation.error.message
          : "Could not send the message."
        : null,
  };
}
