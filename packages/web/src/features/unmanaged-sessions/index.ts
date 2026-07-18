export { MirrorViewScreen } from "./components/mirror-view-screen";
export { TakeOverDialog } from "./components/take-over-dialog";
export { UnmanagedSection } from "./components/unmanaged-section";
export { UnmanagedSessionCard } from "./components/unmanaged-session-card";
export { machineRpcToUnmanagedActions } from "./live-actions";
export { useLiveUnmanagedSessions } from "./live-source";
export { fetchFullTranscript, type MirrorLine, parseMirrorLines } from "./mirror";
export { useMockUnmanagedActions, useMockUnmanagedSessions } from "./mock-source";
export type {
  AdoptMode,
  AdoptTakeOutcome,
  MirrorChunk,
  UnmanagedActions,
  UnmanagedSessionItem,
  UnmanagedSessionsSnapshot,
  UseUnmanagedActions,
  UseUnmanagedSessionsSnapshot,
} from "./types";
export { type MirrorTranscriptState, useMirrorTranscript } from "./use-mirror-transcript";
