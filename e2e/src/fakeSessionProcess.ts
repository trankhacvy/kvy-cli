/**
 * The conformance harness's stand-in for a real `falcon claude
 * --starting-mode remote` session process (design §7.4 "Remote mode" / §7.6
 * "Permission pipeline" / §4.4's "Session RPCs" table).
 *
 * This is NOT a mock of the wire protocol — it drives the real, already-
 * merged building blocks a live session process uses:
 *
 *  - `registerSessionRpcHandlers` (`packages/cli/src/rpc/sessionRpc.ts`) —
 *    the real session-scoped RPC registration/decrypt/validate/dispatch
 *    pipeline, over a real `socket.io-client` connection to the real server.
 *  - `AcpPermissionHandler` (`packages/cli/src/acp/acpPermissionHandler.ts`)
 *    — the real v2 first-wins permission pipeline that `acpRemote.ts` wires
 *    to ACP's `session/request_permission`. (v1's CLI-side auto-rules and
 *    allow-lists moved into the agent process under ACP — see the handler's
 *    own file header — so the harness now only exercises the requests that
 *    genuinely need a human answer, which is exactly what reaches the CLI.)
 *  - `Outbox` (`packages/cli/src/api/outbox.ts`) — the real coalescing HTTP
 *    outbox that POSTs sealed `SessionEnvelope[]` batches to
 *    `/v1/sessions/:id/messages`.
 *
 * What IS simulated: there is no real ACP adapter child behind this — nobody
 * is actually running Claude Code. A `requestTool` call stands in for "the
 * agent decided this tool needs permission and sent
 * `session/request_permission`"; the harness synthesizes that request and
 * interprets the resulting `RequestPermissionResponse` back into an
 * allow/deny for its scripted tool-lifecycle envelopes. That split matches
 * the design doc's own division of labor: real LLM-transcript fidelity is
 * "Provider contract tests" (plan.md §16 "4.4", item 1) — this harness's job
 * is the surrounding machinery (permission pipeline, mode switching, RPC
 * plumbing, reconnect), which is exactly what design §13 item 3 lists.
 */
// Cross-package source imports (harness-only, same convention
// `packages/cli/src/daemon/commands.machineWiring.integration.test.ts` and
// `packages/cli/src/session/bootstrap.integration.test.ts` already
// established): `falcon` (the CLI package) is a private, unpublished
// package with no subpath `exports` for its internals, so this reaches its
// TS source directly rather than through a built `dist/` entry point.
// `falcon` is declared as a devDependency in package.json for
// workspace-graph clarity even though these imports are relative paths, not
// the package name.

import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  createEnvelope,
  type PermDecision,
  type PermissionMode,
  type SessionEnvelope,
} from "@falcon/wire";
import { io as ioClientDefault, type Socket } from "socket.io-client";
import {
  AcpPermissionHandler,
  type PermAnswerResult,
} from "../../packages/cli/src/acp/acpPermissionHandler.js";
import { createHttpClient } from "../../packages/cli/src/api/httpClient.js";
import { Outbox } from "../../packages/cli/src/api/outbox.js";
import type { Logger } from "../../packages/cli/src/logger.js";
import {
  registerSessionRpcHandlers,
  type SessionRpcHandle,
} from "../../packages/cli/src/rpc/index.js";

/** Normalized allow/deny outcome the harness derives from an ACP `RequestPermissionResponse` (see `interpretPermissionResponse`). */
export type CanUseToolResult = { behavior: "allow" | "deny" };

/** The three options the harness offers on every synthesized `session/request_permission`, mirroring a real Claude adapter request. */
const HARNESS_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

/**
 * Maps an ACP permission response back to the allow/deny the harness's
 * tool-lifecycle envelopes need. A `cancelled` outcome (the agent's turn was
 * aborted mid-prompt — how `interrupt()` settles a pending request) throws,
 * preserving the "aborted permission call rejects" contract the conformance
 * interrupt step relies on.
 */
function interpretPermissionResponse(
  response: RequestPermissionResponse,
  options: readonly PermissionOption[],
): CanUseToolResult {
  const outcome = response.outcome;
  if (outcome.outcome !== "selected") {
    throw new Error("permission request cancelled");
  }
  const selected = options.find((o) => o.optionId === outcome.optionId);
  const allowed = selected?.kind === "allow_once" || selected?.kind === "allow_always";
  return { behavior: allowed ? "allow" : "deny" };
}

export interface FakeSessionProcessOptions {
  serverUrl: string;
  token: string;
  sessionId: string;
  dek: Uint8Array;
  /** Scratch dir for the Outbox's disk-backed queue (its own tmp dir, unrelated to the daemon's homeDir). */
  outboxHomeDir: string;
  logger?: Logger;
  ioFactory?: typeof ioClientDefault;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** One conversation turn's worth of scripted tool activity. */
export class FakeSessionProcess {
  readonly sessionId: string;
  readonly socket: Socket;

  private readonly outbox: Outbox;
  private readonly permissionHandler: AcpPermissionHandler;
  private readonly rpcHandle: SessionRpcHandle;
  private readonly logger: Logger;

  private controlMode: "local" | "remote" = "local";
  private permissionMode: PermissionMode = "default";
  private activeAbort: AbortController | undefined;
  private toolCounter = 0;

  private constructor(opts: FakeSessionProcessOptions, socket: Socket) {
    this.sessionId = opts.sessionId;
    this.logger = opts.logger ?? noopLogger;
    this.socket = socket;

    this.outbox = new Outbox({
      sessionId: opts.sessionId,
      dek: opts.dek,
      http: createHttpClient({
        serverUrl: opts.serverUrl,
        headers: { authorization: `Bearer ${opts.token}` },
      }),
      homeDir: opts.outboxHomeDir,
      logger: this.logger,
      flushMs: 20,
      maxBatchSize: 20,
    });

    this.permissionHandler = new AcpPermissionHandler({
      emitEnvelope: (envelope) => this.outbox.enqueue([envelope]),
      onModeChange: (mode) => {
        this.permissionMode = mode;
      },
      logger: this.logger,
    });

    this.rpcHandle = registerSessionRpcHandlers({
      sessionId: opts.sessionId,
      dek: opts.dek,
      socket,
      logger: this.logger,
      handlers: {
        message: (params) => {
          this.outbox.enqueue([params.envelope]);
          return { queued: true };
        },
        interrupt: () => this.handleInterrupt(),
        takeControl: () => this.handleTakeControl(),
        // Under ACP the CLI has no permission-mode auto-rule engine to
        // retune (it lives agent-side); the harness just records the mode
        // the RPC round-tripped, mirroring `commands/start.ts`'s honest
        // "no live session in this state" only inverted — here there IS a
        // (fake) session, so it succeeds.
        setMode: (params) => {
          this.permissionMode = params.mode;
          return { ok: true };
        },
        permAnswer: (params) => this.permissionHandler.resolve(params),
      },
    });
  }

  static async start(opts: FakeSessionProcessOptions): Promise<FakeSessionProcess> {
    const ioFactory = opts.ioFactory ?? ioClientDefault;
    const socket = ioFactory(opts.serverUrl, {
      path: "/v1/stream",
      transports: ["websocket"],
      auth: { token: opts.token, clientType: "session-scoped", sessionId: opts.sessionId },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", (error: Error) => reject(error));
    });
    return new FakeSessionProcess(opts, socket);
  }

  get mode(): "local" | "remote" {
    return this.controlMode;
  }

  /** Emits `turn-start` — call once before a batch of scripted tool activity. */
  emitTurnStart(): void {
    this.outbox.enqueue([createEnvelope("agent", { t: "turn-start" })]);
  }

  /** Emits `turn-end` — call once a scripted turn is done (or `interrupt()` already emitted its own `cancelled` one). */
  emitTurnEnd(status: "completed" | "failed" | "cancelled"): void {
    this.outbox.enqueue([createEnvelope("agent", { t: "turn-end", status })]);
  }

  /**
   * Simulates "the agent decided this tool needs permission": synthesizes a
   * real `session/request_permission` and drives it through the REAL
   * `AcpPermissionHandler` (a pending `perm-request` envelope + promise that
   * settles on the `perm.answer` RPC, or `cancelled` on `interrupt()`). The
   * returned promise resolves to an allow/deny (or REJECTS when the request
   * was cancelled — the aborted-permission contract the interrupt step
   * relies on), exactly as `acpRemote.ts`'s prompt loop would observe it.
   */
  requestTool(name: string, args: Record<string, unknown>): Promise<CanUseToolResult> {
    const controller = new AbortController();
    this.activeAbort = controller;
    const toolUseID = `tool_${++this.toolCounter}`;

    const request: RequestPermissionRequest = {
      sessionId: this.sessionId,
      toolCall: {
        toolCallId: toolUseID,
        rawInput: args,
        _meta: { claudeCode: { toolName: name } },
      },
      options: HARNESS_PERMISSION_OPTIONS,
    } as RequestPermissionRequest;

    const normalized = this.permissionHandler
      .handleRequest(request, controller.signal)
      .then((response) => {
        if (this.activeAbort === controller) this.activeAbort = undefined;
        const result = interpretPermissionResponse(response, HARNESS_PERMISSION_OPTIONS);
        this.emitToolLifecycle(toolUseID, name, args, result);
        return result;
      });

    // Swallow the rejection on the internal branch so a cancelled tool
    // doesn't surface as an unhandled rejection; the caller still sees it via
    // the returned promise.
    normalized.catch(() => {
      if (this.activeAbort === controller) this.activeAbort = undefined;
    });

    return normalized;
  }

  /** Standing in for the user pressing Ctrl-T at the terminal — design §7.5's REMOTE→LOCAL leg has no RPC, only a local action. */
  simulateTerminalTakeback(): void {
    this.controlMode = "local";
    this.outbox.enqueue([
      createEnvelope("agent", { t: "mode-switch", control: "local", by: "terminal" }),
    ]);
  }

  async disconnectSocket(): Promise<void> {
    this.socket.disconnect();
  }

  async reconnectSocket(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("connect", () => resolve());
      this.socket.once("connect_error", (error: Error) => reject(error));
      this.socket.connect();
    });
  }

  dispose(): void {
    this.rpcHandle.stop();
    this.outbox.dispose();
    this.socket.close();
  }

  private handleInterrupt(): { ok: boolean } {
    if (this.activeAbort && !this.activeAbort.signal.aborted) {
      this.activeAbort.abort();
      this.emitTurnEnd("cancelled");
    }
    this.activeAbort = undefined;
    return { ok: true };
  }

  private handleTakeControl(): { ok: boolean } {
    this.controlMode = "remote";
    this.outbox.enqueue([
      createEnvelope("agent", { t: "mode-switch", control: "remote", by: "client" }),
    ]);
    return { ok: true };
  }

  private emitToolLifecycle(
    call: string,
    name: string,
    args: Record<string, unknown>,
    result: CanUseToolResult,
  ): void {
    const envelopes: SessionEnvelope[] = [
      createEnvelope("agent", { t: "tool-start", call, name, args }),
      createEnvelope("agent", {
        t: "tool-end",
        call,
        ok: result.behavior === "allow",
        output: result.behavior === "allow" ? { ran: true } : { denied: true },
      }),
    ];
    this.outbox.enqueue(envelopes);
  }
}

export type { PermAnswerResult, PermDecision, PermissionMode };
