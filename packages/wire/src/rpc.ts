import { z } from "zod";
import { EncryptedBoxSchema } from "./box";
import { PermDecisionSchema, PermissionModeSchema } from "./permissions";
import { SessionEnvelopeSchema } from "./session";

/**
 * RPC call envelope sent over the WS `rpc-call` client emit (design §4.4).
 * `target` is scope-prefixed: `m:<machineId>:<method>` (daemon-registered)
 * or `s:<sessionId>:<method>` (session-process-registered). Params/results
 * are always an `EncryptedBox` — the relay forwards opaque bytes and never
 * inspects RPC bodies.
 */
export const RpcCallSchema = z.object({
  target: z.string(),
  method: z.string(),
  params: EncryptedBoxSchema,
});
export type RpcCall = z.infer<typeof RpcCallSchema>;

// ---------------------------------------------------------------------------
// Machine RPCs — registered by the daemon (design §4.4)
//
// `idempotencyKey` is required on spawn/adopt.*/git.*/fs.read: an RPC ack can
// legitimately be lost after the daemon already ran the call (dead-peer
// fast-fail races the real response), so every caller-retriable machine RPC
// carries a caller-minted key the daemon can use to replay its prior result
// instead of re-running a side effect (or re-reading a file mid-write twice).
// ---------------------------------------------------------------------------

export const SpawnParamsSchema = z.object({
  idempotencyKey: z.string(), // cuid2 minted by caller; daemon replays the prior result on retry
  workspaceId: z.string(),
  directory: z.string(),
  provider: z.enum(["claude-code", "codex"]),
  permissionMode: PermissionModeSchema,
  model: z.string().optional(),
  branch: z
    .object({
      name: z.string(),
      createWorktree: z.boolean(),
    })
    .optional(),
  continueFrom: z
    .object({
      providerSessionId: z.string(),
    })
    .optional(),
});
export type SpawnParams = z.infer<typeof SpawnParamsSchema>;

// `sessionId` is optional (rather than the union `SpawnSessionResult` the
// daemon's loopback controlServer contract uses internally,
// packages/cli/src/daemon/types.ts) because the additive-only policy
// (design §5.3) forbids retyping an already-shipped required field into a
// union — schemaRegistry.ts's compat check would reject that. `requiresApproval`
// is the wire-safe equivalent of that contract's
// `requestToApproveDirectoryCreation` case (plan.md §16 "3.1 Remote spawn"
// — "409 directory-creation approval loop"): the target directory doesn't
// exist yet, so the caller offers to create it (`fs.mkdir`) and retries
// `spawn` with the same `idempotencyKey`. Exactly one of `sessionId` /
// `requiresApproval` is set on any successful (non-throwing) response.
export const SpawnResultSchema = z.object({
  sessionId: z.string().optional(),
  requiresApproval: z
    .object({
      action: z.literal("create-directory"),
      directory: z.string(),
    })
    .optional(),
});
export type SpawnResult = z.infer<typeof SpawnResultSchema>;

export const StopSessionParamsSchema = z.object({
  sessionId: z.string(),
  force: z.boolean().optional(),
});
export const StopSessionResultSchema = z.object({ ok: z.boolean() });

export const ResumeSessionParamsSchema = z.object({ sessionId: z.string() });
export const ResumeSessionResultSchema = z.object({ ok: z.boolean() });

export const ListSessionsParamsSchema = z.object({});

export const LocalSessionInfoSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  provider: z.enum(["claude-code", "codex"]),
  controlMode: z.enum(["local", "remote"]),
  status: z.enum(["active", "failed", "stopped"]),
  pid: z.number().optional(),
  startedAt: z.number(),
});
export type LocalSessionInfo = z.infer<typeof LocalSessionInfoSchema>;

export const ListSessionsResultSchema = z.object({
  sessions: z.array(LocalSessionInfoSchema),
});

export const GitStatusParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
});
export type GitStatusParams = z.infer<typeof GitStatusParamsSchema>;

export const FileStatusSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
});
export type FileStatus = z.infer<typeof FileStatusSchema>;

export const GitStatusResultSchema = z.object({
  branch: z.string(),
  ahead: z.number(),
  behind: z.number(),
  files: z.array(FileStatusSchema),
});
export type GitStatusResult = z.infer<typeof GitStatusResultSchema>;

export const GitDiffParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
  path: z.string().optional(),
  baseRef: z.string().optional(),
});
export type GitDiffParams = z.infer<typeof GitDiffParamsSchema>;

// `truncated` mirrors `FsReadResultSchema`'s own field below — same "no blob
// subsystem yet" contract (design §4.4 "payload size rule"): a diff that
// would blow the 64KB RPC control-plane budget is truncated inline rather
// than dropped, and `truncated: true` tells the caller more content exists.
// `blobRef` is the reserved extension point for the eventual blob-storage
// fallback (plan.md §16 "4.3 Distribution & self-host") — unset until that
// subsystem lands, same as `adopt.mirror`'s own not-yet-wired `blobRef`.
export const GitDiffResultSchema = z.object({
  inline: z.string().optional(),
  blobRef: z.string().optional(),
  truncated: z.boolean(),
});
export type GitDiffResult = z.infer<typeof GitDiffResultSchema>;

export const FsReadParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
  path: z.string(),
  range: z
    .object({
      start: z.number(),
      end: z.number(),
    })
    .optional(),
});
export type FsReadParams = z.infer<typeof FsReadParamsSchema>;

export const FsReadResultSchema = z.object({
  inline: z.string().optional(),
  blobRef: z.string().optional(),
  truncated: z.boolean(),
});
export type FsReadResult = z.infer<typeof FsReadResultSchema>;

// `fs.list`/`fs.mkdir` — the New Session directory picker's daemon-provided
// browsing RPCs (falcon-prd.md FR-7.5 "workspace/directory picker
// (daemon-provided)"; plan.md §16 "3.1 Remote spawn"). Deliberately NOT
// scoped to a `worktree` like `fs.read` above: picking a brand-new
// directory has to work before any workspace/worktree is registered.
// `spawn`'s own workspace-path validation (`workspacePath.ts`) remains the
// actual "no arbitrary-directory execution" boundary (design §12) — these
// two RPCs only let the caller *see* and *create* directories, never run
// anything in them.
export const FsListParamsSchema = z.object({
  idempotencyKey: z.string(),
  /** Absolute path to list; omitted lists the machine's home directory. */
  path: z.string().optional(),
});
export type FsListParams = z.infer<typeof FsListParamsSchema>;

export const FsEntrySchema = z.object({
  name: z.string(),
  isDirectory: z.boolean(),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

export const FsListResultSchema = z.object({
  /** The resolved absolute path that was listed (symlinks followed). */
  path: z.string(),
  /** Absolute path of the parent directory; `null` at the filesystem root. */
  parent: z.string().nullable(),
  entries: z.array(FsEntrySchema),
});
export type FsListResult = z.infer<typeof FsListResultSchema>;

export const FsMkdirParamsSchema = z.object({
  idempotencyKey: z.string(),
  path: z.string(),
});
export type FsMkdirParams = z.infer<typeof FsMkdirParamsSchema>;

export const FsMkdirResultSchema = z.object({ ok: z.boolean() });
export type FsMkdirResult = z.infer<typeof FsMkdirResultSchema>;

export const AdoptListParamsSchema = z.object({
  idempotencyKey: z.string(),
  workspaceId: z.string(),
});

export const ProviderSessionSummarySchema = z.object({
  providerSessionId: z.string(),
  title: z.string().optional(),
  lastActivityAt: z.number(),
  running: z.boolean().optional(),
});
export type ProviderSessionSummary = z.infer<typeof ProviderSessionSummarySchema>;

export const AdoptListResultSchema = z.object({
  items: z.array(ProviderSessionSummarySchema),
});

export const AdoptTakeParamsSchema = z.object({
  idempotencyKey: z.string(),
  providerSessionId: z.string(),
  mode: z.enum(["takeover", "fork"]),
});

// `warning` is set when a 'takeover' actually interrupted a live, mid-turn
// process (design §10.4/FR-9.3: "if the process is mid-turn, show a
// warning") — additive field, absent on 'fork' or when the original process
// was already idle/finished.
export const AdoptTakeResultSchema = z.object({
  sessionId: z.string(),
  warning: z.string().optional(),
});
export type AdoptTakeResult = z.infer<typeof AdoptTakeResultSchema>;
export type AdoptTakeParams = z.infer<typeof AdoptTakeParamsSchema>;

// Read-only transcript mirror (design §4.4 "payload size rule" / §8 /
// plan.md §16 "3.3 Session adoption (UC9)"): serves an unmanaged session's
// transcript on demand in ≤64KB chunks rather than uploading whole
// histories eagerly. `cursor`/`nextCursor` are byte offsets into the
// transcript file; `done: true` on the final chunk (`nextCursor: null`).
// `blobRef` is a reserved extension point for the eventual blob-storage
// fallback for very large transcripts (plan.md §16 "4.3 Distribution &
// self-host") — unset until that subsystem lands, same as `git.diff`/
// `fs.read`'s own not-yet-wired `blobRef`.
export const AdoptMirrorParamsSchema = z.object({
  idempotencyKey: z.string(),
  providerSessionId: z.string(),
  cursor: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().positive().optional(),
});
export type AdoptMirrorParams = z.infer<typeof AdoptMirrorParamsSchema>;

export const AdoptMirrorResultSchema = z.object({
  chunk: z.string(),
  nextCursor: z.number().int().nonnegative().nullable(),
  done: z.boolean(),
  blobRef: z.string().optional(),
});
export type AdoptMirrorResult = z.infer<typeof AdoptMirrorResultSchema>;

// ---------------------------------------------------------------------------
// Session RPCs — registered by the session process (design §4.4)
// ---------------------------------------------------------------------------

export const MessageRpcParamsSchema = z.object({ envelope: SessionEnvelopeSchema });

// Tri-state reply (design §7.10 "Send-idempotency claim", v0.3): protects
// the highest-frequency mutating session RPC end-to-end — a retried or
// duplicated `message` call must never cause the agent to run a turn twice.
// - 'queued': normal accept path (today's only outcome).
// - 'duplicate': a claim for this envelope id already recorded a terminal
//   result — this call is a replay; the caller reconciles as success.
// - 'outcome-unknown': a claim for this envelope id exists with no recorded
//   result (crash mid-turn — the prompt may have partially run). The caller
//   MUST NOT re-execute: reconcile from the transcript instead.
export const MessageRpcStatusSchema = z.enum(["queued", "duplicate", "outcome-unknown"]);
export type MessageRpcStatus = z.infer<typeof MessageRpcStatusSchema>;

// `queued` (unchanged, required) stays exactly as it shipped — the
// additive-only wire policy (design §5.3) forbids retyping an
// already-shipped required field, and the CLI's `message` RPC handler
// (packages/cli/src/commands/start.ts) still only ever sets it: wiring the
// send-idempotency claim store into `deliverMessage()` so the producer can
// actually compute `status` is Phase 2.2 (plan.md §17 "17. v2 — ACP
// migration"), not this change. `status` is therefore additive *and*
// optional — a reply that omits it (every producer today) is still valid,
// and the web composer falls back to the pre-existing `queued`-only
// behavior when it's absent (`optimistic-composer.ts`).
export const MessageRpcResultSchema = z.object({
  queued: z.boolean(),
  status: MessageRpcStatusSchema.optional(),
});

export const PermAnswerParamsSchema = z.object({
  reqId: z.string(),
  decision: PermDecisionSchema,
});

// First-wins across devices (design §7.6): the session process resolves each
// reqId exactly once. The losing answer gets ok:false plus the decision that
// actually won, so the client can render "answered on another device".
export const PermAnswerResultSchema = z.object({
  ok: z.boolean(),
  reason: z.literal("already-answered").optional(),
  decision: PermDecisionSchema.optional(),
});

export const InterruptParamsSchema = z.object({});
export const InterruptResultSchema = z.object({ ok: z.boolean() });

// `stop` (plan.md §16 "2.3 Stop session", plan-v2.md W2.3 "Stop session from
// the web"): a session RPC, not the machine RPC `StopSessionParams/
// ResultSchema` above — the session process is alive, connected, and owns
// its own child, so no daemon round-trip is needed (the daemon doesn't even
// track terminal sessions, design §A9). The machine-RPC `stopSession` stays
// reserved for a dead/daemon-spawned session with no live session-RPC
// target to call directly (plan-v2.md Wave 4 note).
export const StopRpcParamsSchema = z.object({
  /** Graceful by default (SIGTERM to the child, or the remote loop's own
   * exit request); `force: true` additionally exits the whole CLI process
   * after a short grace period even if the child hasn't exited yet. */
  force: z.boolean().optional(),
});
export const StopRpcResultSchema = z.object({ ok: z.boolean() });

export const TakeControlParamsSchema = z.object({});
export const TakeControlResultSchema = z.object({ ok: z.boolean() });

export const SetModeParamsSchema = z.object({ mode: PermissionModeSchema });
export const SetModeResultSchema = z.object({
  ok: z.boolean(),
  // Additive (plan-v2.md W4.3 "Real setMode for the PTY path"): the PTY
  // path can't blindly trust its own Shift+Tab keystrokes landed — it
  // verifies via the next hook input's `permission_mode` echo and reports
  // whatever it actually observed here, so the caller can revert an
  // optimistic UI update to the true mode on a failed/unverified switch.
  // Absent from the remote-loop path (its `setMode` is a real, synchronous
  // ACP call with no separate echo to report) — `ok` alone stays authoritative there.
  observedMode: PermissionModeSchema.optional(),
});
