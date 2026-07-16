import type { PermDecision, PermissionMode, SessionEnvelope } from "@falcon/wire";
import type {
  InterruptResult,
  MessageRpcResult,
  PermAnswerResult,
  SetModeResult,
  TakeControlResult,
} from "@/sync/sessionRpc";

/**
 * The session RPC surface `Composer`/`PermCard`/`ControlBar` need, seamed
 * off from *how* those calls actually reach the session process — same
 * injectable-hook pattern `features/session-list` uses for
 * `UseSessionListSnapshot` (mock by default, swapped for the real
 * `SessionRpcClient`-backed implementation once this screen's data layer —
 * the sync engine + a session-scoped crypto client — lands, a separate
 * task). Every method maps 1:1 onto one of design §4.4's five session RPCs.
 */
export interface SessionControlActions {
  sendMessage(envelope: SessionEnvelope): Promise<MessageRpcResult>;
  answerPermission(reqId: string, decision: PermDecision): Promise<PermAnswerResult>;
  interrupt(): Promise<InterruptResult>;
  takeControl(): Promise<TakeControlResult>;
  setMode(mode: PermissionMode): Promise<SetModeResult>;
}

export type UseSessionControl = (sessionId: string) => SessionControlActions;
