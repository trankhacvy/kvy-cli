/**
 * Ported (adapted) from happy-cli/src/codex/codexAppServerClient.ts (MIT —
 * https://github.com/slopus/happy), fidelity (P) — plan.md §16 "3.4 Codex
 * adapter": "`codex app-server` JSON-RPC stdio client (newline-delimited,
 * hand-rolled)".
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON), spawning
 * `codex app-server --listen stdio://`. Hand-rolled — as Happy's own header
 * notes — because `@openai/codex-sdk` only wraps `codex exec` (non-
 * interactive) and has no support for app-server, interactive approvals, or
 * bidirectional JSON-RPC.
 *
 * Ported faithfully: the request/notify/respond/handleLine transport
 * (pending-map + timeout, epoch-tagged so a reconnect's stale process exit
 * can't reject the new generation's requests), the server->client approval
 * routing for both the legacy (`execCommandApproval`/`applyPatchApproval`)
 * and v2 (`item/commandExecution/requestApproval`/
 * `item/fileChange/requestApproval`) method names, and the decision-to-wire
 * mapping (`mapDecisionToWire`).
 *
 * Deltas from Happy, scoped to plan.md §16's ask (approval routing + the
 * reasoning/diff event mapper — not Happy's full conversation-management
 * surface):
 *
 *  - **No sandbox wrapping.** Happy's `connect()` optionally re-execs the
 *    process through a Seatbelt sandbox wrapper (`initializeSandbox`/
 *    `wrapForMcpTransport`, a whole separate subsystem). Falcon has no
 *    sandbox subsystem yet, so `connect()` always spawns `codex app-server`
 *    directly.
 *  - **No `mcpServer/elicitation/request` routing.** Happy also routes MCP
 *    tool elicitation prompts through the same approval flow; plan.md §16
 *    only names `exec:request`/`patch:request`, so that third kind is
 *    dropped.
 *  - **No fork/rollback/inject/goal RPCs.** `thread/fork`, `thread/rollback`,
 *    `thread/inject_items`, `thread/goal/*` are Happy features (collab
 *    sub-agents, goal tracking) with no equivalent in Falcon's design doc.
 *  - **Injectable process spawn (`CodexProcessLike`/`spawn`)** replaces
 *    Happy's direct `cross-spawn` call at the top of `connect()` — same
 *    testable-seam pattern as `claudeCliLocator.ts`'s injectable `locate`:
 *    tests drive a fake newline-delimited stdio pair instead of shelling out
 *    to a real `codex` binary.
 *  - **`detect()` is a separate injected `isAvailable` check**, not
 *    `execSync('codex --version')` baked into `connect()` — same rationale,
 *    testability without a real `codex` install on the host.
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { spawn as crossSpawn } from "cross-spawn";
import type { Logger } from "../logger.js";
import type {
  ApprovalResponse,
  EventMsg,
  InputItem,
  JsonRpcRequest,
  NewConversationParams,
  NewConversationResponse,
  ReasoningEffort,
  ResumeConversationParams,
  ResumeConversationResponse,
  ReviewDecision,
  SandboxMode,
} from "./codexAppServerTypes.js";

export type { ReviewDecision } from "./codexAppServerTypes.js";

/** Minimal surface `CodexAppServerClient` needs from a spawned child process — injectable for tests. */
export interface CodexProcessLike {
  readonly pid?: number;
  readonly stdin: { writable: boolean; write(chunk: string): void; end(): void } | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type ApprovalKind = "exec" | "patch";

export interface ApprovalRequest {
  type: ApprovalKind;
  /** Adapter-facing call id — scoped `${threadId}:${itemId}` when a thread id is known, so the same id can join a permission card to its tool call by exact equality. */
  callId: string;
  command?: string[];
  cwd?: string;
  fileChanges?: Record<string, unknown>;
  reason?: string | null;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ReviewDecision>;
export type EventHandler = (msg: EventMsg) => void;

export interface CodexAppServerClientDeps {
  /** Defaults to `cross-spawn`. Injectable so tests can drive a fake stdio pair. */
  spawn?: (command: string, args: string[]) => CodexProcessLike;
  logger?: Logger;
  /** Default 30s per-request timeout. */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  epoch: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Scopes an item id to its thread so ids from different threads never collide. */
function formatScopedCallId(threadId: string | undefined, itemId: string): string {
  return threadId ? `${threadId}:${itemId}` : itemId;
}

/**
 * Maps a `ReviewDecision` to the wire value the app-server expects.
 * v2 (`item/*`) methods use `accept`/`acceptForSession`/`decline`/`cancel`;
 * legacy methods (`execCommandApproval`/`applyPatchApproval`) use the
 * `ReviewDecision` strings verbatim.
 */
function mapDecisionToWire(decision: ReviewDecision, legacy: boolean): string {
  if (legacy) return decision;
  switch (decision) {
    case "approved":
      return "accept";
    case "approved_for_session":
      return "acceptForSession";
    case "denied":
      return "decline";
    case "abort":
      return "cancel";
  }
}

function defaultSpawn(command: string, args: string[]): CodexProcessLike {
  return crossSpawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as unknown as CodexProcessLike;
}

/**
 * Hand-rolled JSON-RPC 2.0 stdio client for `codex app-server`. One instance
 * owns exactly one Codex thread's transport: spawn, `initialize` handshake,
 * `thread/start`/`thread/resume`, `turn/start`/`turn/interrupt`, and
 * server->client approval requests routed to an injected `ApprovalHandler`.
 * `codex/event` notifications are handed to an injected `EventHandler` —
 * mapping them onto `SessionEnvelope`s is `envelopeMapper.ts`'s job, kept
 * separate so this class stays a pure transport.
 */
export class CodexAppServerClient {
  private readonly deps: Required<Pick<CodexAppServerClientDeps, "spawn" | "requestTimeoutMs">> &
    Pick<CodexAppServerClientDeps, "logger">;
  private process: CodexProcessLike | null = null;
  private readline: ReadlineInterface | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private processEpoch = 0;
  private connected = false;

  private threadIdValue: string | null = null;
  private turnIdValue: string | null = null;

  private approvalHandler: ApprovalHandler | null = null;
  private eventHandler: EventHandler | null = null;

  constructor(deps: CodexAppServerClientDeps = {}) {
    this.deps = {
      spawn: deps.spawn ?? defaultSpawn,
      requestTimeoutMs: deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      logger: deps.logger,
    };
  }

  get threadId(): string | null {
    return this.threadIdValue;
  }

  get turnId(): string | null {
    return this.turnIdValue;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  setEventHandler(handler: EventHandler): void {
    this.eventHandler = handler;
  }

  /** Spawns `codex app-server --listen stdio://` and performs the `initialize` handshake. */
  async connect(
    opts: { command?: string; args?: string[]; clientVersion?: string } = {},
  ): Promise<void> {
    if (this.connected) return;

    const command = opts.command ?? "codex";
    const args = opts.args ?? ["app-server", "--listen", "stdio://"];
    const epoch = ++this.processEpoch;

    const proc = this.deps.spawn(command, args);
    this.process = proc;

    proc.on("error", (err) => {
      this.deps.logger?.debug("[codex-app-server] process error", { message: err.message });
    });

    proc.on("exit", (code, signal) => {
      if (this.process !== proc || this.processEpoch !== epoch) return;
      this.connected = false;
      this.deps.logger?.debug("[codex-app-server] process exited", { code, signal });
      for (const [id, req] of this.pending) {
        if (req.epoch !== epoch) continue;
        req.reject(
          new Error(
            `Codex process exited (code=${code ?? "null"}) while waiting for ${req.method}`,
          ),
        );
        this.pending.delete(id);
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      if (this.process !== proc || this.processEpoch !== epoch) return;
      const text = chunk.toString().trim();
      if (text) this.deps.logger?.debug("[codex-app-server:stderr]", { text });
    });

    if (!proc.stdout) throw new Error("Codex process has no stdout");
    this.readline = createInterface({ input: proc.stdout });
    this.readline.on("line", (line) => {
      if (this.process !== proc || this.processEpoch !== epoch) return;
      this.handleLine(line, epoch);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "falcon-codex",
        title: "Falcon Codex Client",
        version: opts.clientVersion ?? "0.0.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
    this.connected = true;
    this.deps.logger?.debug("[codex-app-server] connected and initialized");
  }

  async disconnect(): Promise<void> {
    if (!this.connected && !this.process) return;
    const proc = this.process;
    const epoch = this.processEpoch;

    this.readline?.close();
    this.readline = null;

    try {
      proc?.stdin?.end();
      proc?.kill("SIGTERM");
    } catch {
      // best-effort — the process may already be gone
    }

    this.process = null;
    this.connected = false;
    this.threadIdValue = null;
    this.turnIdValue = null;

    for (const [id, req] of this.pending) {
      if (req.epoch !== epoch) continue;
      req.reject(new Error(`Codex process disconnected while waiting for ${req.method}`));
      this.pending.delete(id);
    }
  }

  async startThread(opts: {
    model?: string;
    cwd?: string;
    approvalPolicy?: NewConversationParams["approvalPolicy"];
    sandbox?: SandboxMode;
  }): Promise<{ threadId: string; model: string }> {
    const params: NewConversationParams = {
      model: opts.model ?? null,
      modelProvider: null,
      profile: null,
      cwd: opts.cwd ?? process.cwd(),
      approvalPolicy: opts.approvalPolicy ?? null,
      sandbox: opts.sandbox ?? null,
      config: null,
      baseInstructions: null,
      developerInstructions: null,
      compactPrompt: null,
      includeApplyPatchTool: null,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    };
    const result = (await this.request("thread/start", params)) as NewConversationResponse;
    this.threadIdValue = result.thread.id;
    this.turnIdValue = null;
    return { threadId: result.thread.id, model: result.model };
  }

  async resumeThread(opts: {
    threadId: string;
    model?: string;
    cwd?: string;
    approvalPolicy?: NewConversationParams["approvalPolicy"];
    sandbox?: SandboxMode;
  }): Promise<{ threadId: string; model: string }> {
    const params: ResumeConversationParams = {
      threadId: opts.threadId,
      model: opts.model ?? null,
      modelProvider: null,
      cwd: opts.cwd ?? process.cwd(),
      approvalPolicy: opts.approvalPolicy ?? null,
      sandbox: opts.sandbox ?? null,
      config: null,
      baseInstructions: null,
      developerInstructions: null,
      persistExtendedHistory: true,
    };
    const result = (await this.request("thread/resume", params)) as ResumeConversationResponse;
    this.threadIdValue = result.thread.id;
    this.turnIdValue = null;
    return { threadId: result.thread.id, model: result.model };
  }

  /** Sends one user turn. Returns immediately — the turn's lifecycle plays out via `codex/event` notifications. */
  async sendTurn(
    prompt: string,
    opts: { model?: string; cwd?: string; effort?: ReasoningEffort } = {},
  ): Promise<{ turnId: string | null }> {
    if (!this.threadIdValue)
      throw new Error("No active thread — call startThread/resumeThread first");

    const input: InputItem[] = [{ type: "text", text: prompt }];
    const params: Record<string, unknown> = { threadId: this.threadIdValue, input };
    if (opts.cwd) params.cwd = opts.cwd;
    if (opts.model) params.model = opts.model;
    if (opts.effort) params.effort = opts.effort;

    const result = (await this.request("turn/start", params)) as { turn?: { id?: string | null } };
    const turnId = stringOrUndefined(result?.turn?.id) ?? null;
    if (turnId) this.turnIdValue = turnId;
    return { turnId };
  }

  async interruptTurn(): Promise<void> {
    if (!this.threadIdValue || !this.turnIdValue) return;
    try {
      await this.request("turn/interrupt", {
        threadId: this.threadIdValue,
        turnId: this.turnIdValue,
      });
    } catch (error) {
      this.deps.logger?.debug("[codex-app-server] interruptTurn error (may be expected)", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // --- JSON-RPC transport ---

  private request(method: string, params?: unknown): Promise<unknown> {
    const timeoutMs = this.deps.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error(`Cannot send ${method}: stdin not writable`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms (id=${id})`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        method,
        epoch: this.processEpoch,
      });

      const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.process.stdin.write(`${JSON.stringify(msg)}\n`);
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.process?.stdin?.writable) return;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", method, params };
    this.process.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private respond(id: number, result: unknown): void {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  private handleLine(line: string, sourceEpoch: number): void {
    if (sourceEpoch !== this.processEpoch || !line.trim()) return;

    let msg: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string; code: number };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      this.deps.logger?.debug("[codex-app-server] non-JSON line", { line: line.slice(0, 200) });
      return;
    }

    // Response to one of our own requests.
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(
          new Error(`${pending.method}: ${msg.error.message} (code=${msg.error.code})`),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server -> client request (an approval).
    if (msg.id != null && msg.method) {
      this.handleServerRequest(msg.id, msg.method, msg.params).catch((error) => {
        this.deps.logger?.debug("[codex-app-server] error handling server request", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }

    // Notification.
    if (msg.method) {
      this.handleNotification(msg.method, msg.params);
    }
  }

  private async handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    const p = (params ?? {}) as Record<string, unknown>;

    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
      const legacy = method === "execCommandApproval";
      const threadId =
        stringOrUndefined(p.threadId) ??
        stringOrUndefined(p.conversationId) ??
        this.threadIdValue ??
        undefined;
      const itemId = stringOrUndefined(p.itemId) ?? stringOrUndefined(p.callId) ?? String(id);
      const callId = legacy ? itemId : formatScopedCallId(threadId, itemId);
      const rawCommand = p.command;
      const command = Array.isArray(rawCommand)
        ? rawCommand.filter((part): part is string => typeof part === "string")
        : typeof rawCommand === "string"
          ? [rawCommand]
          : [];
      const decision = await this.dispatchApproval({
        type: "exec",
        callId,
        command,
        cwd: stringOrUndefined(p.cwd),
        reason: stringOrUndefined(p.reason) ?? null,
      });
      const response: ApprovalResponse = { decision: mapDecisionToWire(decision, legacy) };
      this.respond(id, response);
      return;
    }

    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      const legacy = method === "applyPatchApproval";
      const threadId =
        stringOrUndefined(p.threadId) ??
        stringOrUndefined(p.conversationId) ??
        this.threadIdValue ??
        undefined;
      const itemId = stringOrUndefined(p.itemId) ?? stringOrUndefined(p.callId) ?? String(id);
      const callId = legacy ? itemId : formatScopedCallId(threadId, itemId);
      const fileChanges = p.fileChanges ?? p.changes;
      const decision = await this.dispatchApproval({
        type: "patch",
        callId,
        fileChanges:
          fileChanges && typeof fileChanges === "object"
            ? (fileChanges as Record<string, unknown>)
            : undefined,
        reason: stringOrUndefined(p.reason) ?? null,
      });
      const response: ApprovalResponse = { decision: mapDecisionToWire(decision, legacy) };
      this.respond(id, response);
      return;
    }

    // Unknown server request — respond so the app-server doesn't hang.
    this.deps.logger?.debug("[codex-app-server] unknown server request", { method });
    this.respond(id, {});
  }

  private async dispatchApproval(request: ApprovalRequest): Promise<ReviewDecision> {
    if (!this.approvalHandler) return "denied";
    try {
      return await this.approvalHandler(request);
    } catch (error) {
      this.deps.logger?.debug("[codex-app-server] approval handler error", {
        message: error instanceof Error ? error.message : String(error),
      });
      return "denied";
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "codex/event") {
      this.deps.logger?.debug("[codex-app-server] notification", { method });
      return;
    }
    const msg = (params as { msg?: EventMsg } | undefined)?.msg;
    if (!msg) return;

    if (msg.type === "task_started") {
      const turnId = stringOrUndefined(msg.turn_id) ?? stringOrUndefined(msg.turnId);
      if (turnId) this.turnIdValue = turnId;
    }
    if (msg.type === "task_complete" || msg.type === "turn_aborted") {
      this.turnIdValue = null;
    }

    this.eventHandler?.(msg);
  }
}
