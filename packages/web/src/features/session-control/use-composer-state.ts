"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { uploadAttachment } from "@/lib/blobs";
import { getToken } from "@/lib/session";
import type { RenderItem } from "@/sync/reducer";
import {
  buildFileEnvelope,
  buildMessageEnvelope,
  deliveryNotice,
  mergeRenderItems,
  type PendingMessage,
  reconcileByStatus,
  reconcilePending,
  translateSendError,
} from "./optimistic-composer";
import { useSessionControl } from "./session-control-context";
import { useSessionCrypto } from "./use-session-crypto";

export interface ComposerState {
  /** `items` with every still-unreconciled pending send merged in by `time`
   * (design §9.1: "optimistic timeline insert reconciled by echo update").
   * Feed this to `Timeline`, not the raw `items` prop. */
  mergedItems: RenderItem[];
  send(text: string): void;
  /** Encrypts + uploads `file` (composer attach path, plan.md §16 "4.3
   * Distribution & self-host") then sends a `file` envelope referencing the
   * resulting blob. */
  sendAttachment(file: File): void;
  isSending: boolean;
  /** True while the most recently sent message is queued behind the agent's
   * current turn (the `message` RPC's own `{queued: boolean}` result). */
  isQueued: boolean;
  /** Whether this session's crypto bridge has unwrapped its DEK yet — an
   * attachment can't be encrypted (`sendAttachment` throws) until this is
   * `true` (plan-v2.md W4.2 "disabled-until-crypto-ready attach button"). A
   * text-only send doesn't depend on this — the composer's Send button is
   * never gated on it, only the attach affordance is. */
  cryptoReady: boolean;
  error: string | null;
  /** Non-blocking notice from an `outcome-unknown` `message` reply (design
   * §7.10) — never blocks the composer, and clears itself on the next send. */
  notice: string | null;
}

/**
 * The `Composer`'s TanStack Query mutations (falcon-system-design.md §9.1;
 * plan.md §16 "2.4 Web control surface": "TanStack Query mutation calling
 * session RPC `message`"), factored out of the component so `Timeline` and
 * `Composer` can share the same merged/reconciled item list without lifting
 * a `useMutation` call through props. On failure the optimistic entry is
 * dropped — a failed send never lingers as a lie in the transcript.
 *
 * `sendAttachment` shares the crypto bridge `useLiveSessionControl` already
 * unwraps for this session (`useSessionCrypto`, same instance
 * `useLiveRenderItems` decrypts the transcript with) — encrypting an
 * attachment under the wrong session's blob key would be a correctness bug,
 * not just a missing feature, so this deliberately reuses that single
 * source of truth rather than re-deriving anything.
 */
export function useComposerState(items: RenderItem[]): ComposerState {
  const { actions, sessionId, machineOffline } = useSessionControl();
  const cryptoBridge = useSessionCrypto(sessionId);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // Drop any pending entry once the real echo has landed in `items`.
  useEffect(() => {
    setPending((prev) => reconcilePending(prev, items));
  }, [items]);

  // Feature 2 (docs/web-ux-improvements-plan.md §2.2d): the composer never
  // hard-blocks on `machineOffline` — we don't queue, so a non-blocking
  // heads-up is set BEFORE the mutation fires rather than after a failure,
  // giving the user the honest expectation up front. A real failure still
  // gets its own translated message below.
  const machineOfflineNotice = "That machine is offline right now. The message may not go through.";

  const mutation = useMutation({
    mutationFn: async (text: string) => {
      const envelope = buildMessageEnvelope(text);
      const localId = envelope.id;
      setNotice(machineOffline ? machineOfflineNotice : null);
      setPending((prev) => [
        ...prev,
        { kind: "text", localId, text, sentAt: envelope.time, queued: false },
      ]);
      try {
        const result = await actions.sendMessage(envelope);
        setPending((prev) => reconcileByStatus(prev, localId, result));
        setNotice(deliveryNotice(result) ?? (machineOffline ? machineOfflineNotice : null));
        return result;
      } catch (error) {
        setPending((prev) => prev.filter((p) => p.localId !== localId));
        const raw = error instanceof Error ? error.message : String(error);
        throw new Error(translateSendError(raw, machineOffline));
      }
    },
  });

  const attachMutation = useMutation({
    mutationFn: async (file: File) => {
      const localId = globalThis.crypto.randomUUID();
      const sentAt = Date.now();
      setNotice(null);
      setPending((prev) => [
        ...prev,
        { kind: "file", localId, name: file.name, size: file.size, sentAt, queued: false },
      ]);
      try {
        if (!cryptoBridge) {
          throw new Error("Session key isn't unwrapped yet. Try again in a moment.");
        }
        const token = getToken();
        if (!token) {
          throw new Error("Not signed in.");
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const blobId = await uploadAttachment(token, cryptoBridge, bytes, { sessionId });
        const envelope = buildFileEnvelope(
          { ref: blobId, name: file.name, size: file.size },
          { time: sentAt, id: localId },
        );
        const result = await actions.sendMessage(envelope);
        setPending((prev) => reconcileByStatus(prev, localId, result));
        setNotice(deliveryNotice(result));
        return result;
      } catch (error) {
        setPending((prev) => prev.filter((p) => p.localId !== localId));
        const raw = error instanceof Error ? error.message : String(error);
        throw new Error(translateSendError(raw, machineOffline));
      }
    },
  });

  return {
    mergedItems: mergeRenderItems(items, pending),
    send: (text) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      mutation.mutate(trimmed);
    },
    sendAttachment: (file) => {
      attachMutation.mutate(file);
    },
    isSending: mutation.isPending || attachMutation.isPending,
    isQueued: pending.some((p) => p.queued),
    cryptoReady: cryptoBridge !== null,
    error: describeError(mutation) ?? describeError(attachMutation),
    notice,
  };
}

function describeError(mutation: { status: string; error: unknown }): string | null {
  if (mutation.status !== "error") return null;
  return mutation.error instanceof Error ? mutation.error.message : "Could not send.";
}
