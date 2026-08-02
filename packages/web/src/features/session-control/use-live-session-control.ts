"use client";

import { useMemo } from "react";
import { apiSocket, createSessionRpcClient } from "@/sync";
import { sessionRpcToActions } from "./live-actions";
import type { SessionControlActions } from "./types";
import { useSessionCrypto } from "./use-session-crypto";

const NOT_READY_MESSAGE = "Session key isn't unwrapped yet. Try again in a moment.";

/** Every method rejects with the same message until `useSessionCrypto`
 * resolves — never hangs, never throws synchronously during render (design
 * principle: no silent failures). Structurally satisfies
 * `SessionControlActions`: each method here takes no arguments, which is
 * assignable to any of the real methods' (wider) parameter lists. */
function pendingSessionControl(): SessionControlActions {
  const notReady = () => Promise.reject(new Error(NOT_READY_MESSAGE));
  return {
    sendMessage: notReady,
    answerPermission: notReady,
    interrupt: notReady,
    takeControl: notReady,
    setMode: notReady,
    setModel: notReady,
    stopSession: notReady,
  };
}

/**
 * note: swapping `useMockSessionControl` for
 * `(id) => sessionRpcToActions(createSessionRpcClient({...}))` is "a
 * one-line change here — no other change needed anywhere in
 * `Composer`/`PermCard`/`ControlBar`"). Shares its `CryptoBridgeClient` with
 * `useLiveRenderItems` via `useSessionCrypto` (same `sessionId` in, same
 * worker instance's unwrapped DEK out) so a `message`/`perm.answer` RPC call
 * and a transcript decrypt never disagree about which session's key is
 * loaded.
 */
export function useLiveSessionControl(sessionId: string): SessionControlActions {
  const crypto = useSessionCrypto(sessionId);

  return useMemo(() => {
    if (!crypto) return pendingSessionControl();
    return sessionRpcToActions(createSessionRpcClient({ socket: apiSocket, crypto, sessionId }));
  }, [crypto, sessionId]);
}
