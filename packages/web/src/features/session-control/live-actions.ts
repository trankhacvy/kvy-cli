import type { SessionRpcClient } from "@/sync/sessionRpc";
import type { SessionControlActions } from "./types";

/**
 * Adapts a `SessionRpcClient` (`@/sync/sessionRpc.ts`) to the
 * `SessionControlActions` surface these components consume — a one-line
 * seam so wiring the real thing in, once a screen has a live `apiSocket` +
 * a crypto client holding the session's unwrapped DEK, is exactly that: a
 * one-line swap of `useMockSessionControl` for
 * `(sessionId) => sessionRpcToActions(createSessionRpcClient({...}))`, no
 * change to `Composer`/`PermCard`/`ControlBar` themselves.
 */
export function sessionRpcToActions(rpc: SessionRpcClient): SessionControlActions {
  return {
    sendMessage: (envelope) => rpc.call("message", { envelope }),
    answerPermission: (reqId, decision) => rpc.call("perm.answer", { reqId, decision }),
    interrupt: () => rpc.call("interrupt", {}),
    takeControl: () => rpc.call("takeControl", {}),
    setMode: (mode) => rpc.call("setMode", { mode }),
    stopSession: (force) => rpc.call("stop", { force }),
  };
}
