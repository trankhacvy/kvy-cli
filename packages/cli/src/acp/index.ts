/**
 * ACP transport barrel (design §7.3/§7.4/§7.9/§7.10, plan.md §16 "17. v2 —
 * ACP migration / Phase 2.1 — ACP core"). Standalone — not yet wired into
 * `claudeRemoteLauncher.ts` (Phase 2.2's job).
 */
export type {
  AcpConnectionDeps,
  AcpConnectionOptions,
  AcpConnectionState,
  PermissionRequestHandler,
  SessionUpdateListener,
  SpawnFn,
} from "./acpConnection.js";
export { AcpConnection, AcpConnectionError } from "./acpConnection.js";
export type {
  AcpPermissionHandlerDeps,
  AgentStateCompletedRequest,
  AgentStateRequest,
  AgentStateSnapshot,
  PermAnswerResult,
} from "./acpPermissionHandler.js";
export { AcpPermissionHandler } from "./acpPermissionHandler.js";
export type { AcpEnvelopeMapperState, AcpSessionUpdate } from "./acpToEnvelope.js";
export {
  closeAcpTurnWithStatus,
  createAcpEnvelopeMapperState,
  endAcpTurn,
  flushAcpText,
  mapAcpStopReasonToTurnStatus,
  mapAcpUpdateToEnvelopes,
  startAcpTurn,
} from "./acpToEnvelope.js";
