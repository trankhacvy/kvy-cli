import type {
  PermDecision,
  PermissionMode,
  RunningSessionModelAlias,
  SessionEnvelope,
} from "@kvy/wire";
import type {
  InterruptResult,
  MessageRpcResult,
  PermAnswerResult,
  SetModelResult,
  SetModeResult,
  StopRpcResult,
  TakeControlResult,
} from "@/sync/sessionRpc";

/**
 * The session RPC surface `Composer`/`PermCard`/`ControlBar` need, seamed
 * off from *how* those calls actually reach the session process — same
 * injectable-hook pattern `features/session-list` uses for
 * `UseSessionListSnapshot` (mock by default, swapped for the real
 * `SessionRpcClient`-backed implementation once this screen's data layer —
 * the sync engine + a session-scoped crypto client — lands, a separate
 */
export interface SessionControlActions {
  sendMessage(envelope: SessionEnvelope): Promise<MessageRpcResult>;
  answerPermission(reqId: string, decision: PermDecision): Promise<PermAnswerResult>;
  interrupt(): Promise<InterruptResult>;
  takeControl(): Promise<TakeControlResult>;
  setMode(mode: PermissionMode): Promise<SetModeResult>;
  setModel(model: RunningSessionModelAlias): Promise<SetModelResult>;
  stopSession(force?: boolean): Promise<StopRpcResult>;
}

export type UseSessionControl = (sessionId: string) => SessionControlActions;
