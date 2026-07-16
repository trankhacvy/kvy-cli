/**
 * Ported (trimmed) from happy-cli/src/codex/codexAppServerTypes.ts (MIT —
 * https://github.com/slopus/happy), fidelity (P) — plan.md §16 "3.4 Codex
 * adapter": "`codex app-server` JSON-RPC stdio client (newline-delimited,
 * hand-rolled)".
 *
 * Happy's own header describes these as "cherry-picked types from `codex
 * app-server generate-ts`" — this file cherry-picks further, down to only
 * the methods `codexAppServerClient.ts` actually calls: the `initialize`
 * handshake, `thread/start` + `thread/resume` (new/resume conversation),
 * `turn/start` + `turn/interrupt`, and the two approval request shapes
 * (`exec`/`patch`). Happy's richer surface (fork/rollback/inject/goal
 * actions, collab-agent sub-threads, MCP elicitation) is out of scope here —
 * plan.md §16 only asks for approval routing + the reasoning/diff event
 * mapper, not Happy's full conversation-management feature set.
 */

export type ThreadId = string;

// --- Initialize ---

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: { experimentalApi: boolean } | null;
}

export interface InitializeResponse {
  userAgent: string;
}

// --- Thread lifecycle ---

export interface NewConversationParams {
  model: string | null;
  modelProvider: string | null;
  profile: string | null;
  cwd: string | null;
  approvalPolicy: ApprovalPolicy | null;
  sandbox: SandboxMode | null;
  config: Record<string, unknown> | null;
  baseInstructions: string | null;
  developerInstructions: string | null;
  compactPrompt: string | null;
  includeApplyPatchTool: boolean | null;
  experimentalRawEvents: boolean;
  persistExtendedHistory: boolean;
}

export interface NewConversationResponse {
  thread: { id: ThreadId; path: string };
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: ApprovalPolicy;
  reasoningEffort: ReasoningEffort | null;
}

export interface ResumeConversationParams {
  threadId: ThreadId;
  model: string | null;
  modelProvider: string | null;
  cwd: string | null;
  approvalPolicy: ApprovalPolicy | null;
  sandbox: SandboxMode | null;
  config: Record<string, unknown> | null;
  baseInstructions: string | null;
  developerInstructions: string | null;
  persistExtendedHistory: boolean;
}

export type ResumeConversationResponse = NewConversationResponse;

// --- Turn lifecycle ---

export interface SendUserTurnParams {
  threadId: ThreadId;
  input: InputItem[];
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  sandboxPolicy?: SandboxPolicy;
  model?: string;
  effort?: ReasoningEffort;
}

export interface InterruptConversationParams {
  threadId: ThreadId;
  turnId: string;
}

export interface InterruptConversationResponse {
  abortReason: TurnAbortReason;
}

// --- Approvals (server -> client requests) ---

export interface ExecCommandApprovalParams {
  conversationId?: ThreadId;
  threadId?: ThreadId;
  callId?: string;
  itemId?: string;
  approvalId?: string | null;
  command: string[] | string;
  cwd?: string;
  reason?: string | null;
}

export interface ApplyPatchApprovalParams {
  conversationId?: ThreadId;
  threadId?: ThreadId;
  callId?: string;
  itemId?: string;
  fileChanges?: Record<string, FileChange>;
  changes?: Record<string, FileChange>;
  reason?: string | null;
}

export interface ApprovalResponse {
  /**
   * The wire string sent back to the app-server. Typed loosely (`string`,
   * not `ReviewDecision`) because the actual value differs by method
   * generation: legacy methods (`execCommandApproval`/`applyPatchApproval`)
   * echo a `ReviewDecision` verbatim, while v2 methods (`item/*`) send
   * `accept`/`acceptForSession`/`decline`/`cancel` instead (see
   * `mapDecisionToWire` in `codexAppServerClient.ts`).
   */
  decision: string;
}

/** Decision returned to the app-server for an `exec`/`patch` approval request. */
export type ReviewDecision = "approved" | "approved_for_session" | "denied" | "abort";

// --- Shared enums ---

export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type TurnAbortReason = "interrupted" | "replaced" | "review_ended";

export type InputItem = { type: "text"; text: string };

export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly" }
  | { type: "workspaceWrite"; networkAccess: boolean };

export type FileChange =
  | { type: "add"; content: string }
  | { type: "delete"; content: string }
  | { type: "update"; unified_diff: string; move_path: string | null };

// --- Events ---
// Events arrive as `codex/event` notifications with `{ msg: EventMsg }`. Typed
// loosely (same as Happy's own comment): `EventMsg`'s shape varies per
// `type`, and the mapper (envelopeMapper.ts) narrows per-field with runtime
// checks rather than a discriminated union, so a Codex version skew that
// adds/renames a field degrades to "envelope dropped", never a thrown error.
export type EventMsg = { type: string } & Record<string, unknown>;

// --- JSON-RPC 2.0 wire types ---

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
