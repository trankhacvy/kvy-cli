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

export const GitDiffParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
  path: z.string().optional(),
  baseRef: z.string().optional(),
});

export const GitDiffResultSchema = z.object({
  inline: z.string().optional(),
  blobRef: z.string().optional(),
});

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

export const FsReadResultSchema = z.object({
  inline: z.string().optional(),
  blobRef: z.string().optional(),
  truncated: z.boolean(),
});

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

export const AdoptTakeResultSchema = z.object({ sessionId: z.string() });

// ---------------------------------------------------------------------------
// Session RPCs — registered by the session process (design §4.4)
// ---------------------------------------------------------------------------

export const MessageRpcParamsSchema = z.object({ envelope: SessionEnvelopeSchema });
export const MessageRpcResultSchema = z.object({ queued: z.boolean() });

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

export const TakeControlParamsSchema = z.object({});
export const TakeControlResultSchema = z.object({ ok: z.boolean() });

export const SetModeParamsSchema = z.object({ mode: PermissionModeSchema });
export const SetModeResultSchema = z.object({ ok: z.boolean() });
