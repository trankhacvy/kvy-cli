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
 *  - `PermissionHandler` (`packages/cli/src/claude/permissionHandler.ts`) —
 *    the real auto-rule/allow-list/first-wins permission pipeline that
 *    `claudeRemote.ts` wires `canUseTool` to.
 *  - `Outbox` (`packages/cli/src/api/outbox.ts`) — the real coalescing HTTP
 *    outbox that POSTs sealed `SessionEnvelope[]` batches to
 *    `/v1/sessions/:id/messages`.
 *
 * What IS simulated: there is no real `@anthropic-ai/claude-agent-sdk`
 * `query()` behind this — nobody is actually running Claude Code. Tool
 * calls are scripted by the harness (`requestTool`), not decided by a real
 * model. That split matches the design doc's own division of labor: real
 * LLM-transcript fidelity is "Provider contract tests" (plan.md §16 "4.4",
 * item 1, a separate task that runs the real provider CLI against fixture
 * prompts) — this harness's job is the surrounding machinery (permission
 * pipeline, mode switching, RPC plumbing, reconnect), which is exactly what
 * design §13 item 3 lists.
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

import {
  createEnvelope,
  type PermDecision,
  type PermissionMode,
  type SessionEnvelope,
} from "@falcon/wire";
import { io as ioClientDefault, type Socket } from "socket.io-client";
import { createHttpClient } from "../../packages/cli/src/api/httpClient.js";
import { Outbox } from "../../packages/cli/src/api/outbox.js";
import {
  type PermAnswerResult,
  PermissionHandler,
} from "../../packages/cli/src/claude/permissionHandler.js";
import type { Logger } from "../../packages/cli/src/logger.js";
import {
  registerSessionRpcHandlers,
  type SessionRpcHandle,
} from "../../packages/cli/src/rpc/index.js";

export type CanUseToolResult = Awaited<ReturnType<PermissionHandler["canUseTool"]>>;

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
  private readonly permissionHandler: PermissionHandler;
  private readonly rpcHandle: SessionRpcHandle;
  private readonly logger: Logger;

  private controlMode: "local" | "remote" = "local";
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

    this.permissionHandler = new PermissionHandler({
      emitEnvelope: (envelope) => this.outbox.enqueue([envelope]),
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
        setMode: (params) => {
          this.permissionHandler.setMode(params.mode);
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
   * Simulates "the model decided to call a tool": runs the REAL
   * `PermissionHandler.canUseTool` (auto-rules, allow-lists, or a genuine
   * pending `perm-request` envelope + promise). The harness awaits (or races
   * against `interrupt()`) the returned promise exactly like
   * `claudeRemote.ts`'s SDK pump would.
   */
  requestTool(name: string, args: Record<string, unknown>): Promise<CanUseToolResult> {
    const controller = new AbortController();
    this.activeAbort = controller;
    const toolUseID = `tool_${++this.toolCounter}`;

    const pending = this.permissionHandler.canUseTool(name, args, {
      signal: controller.signal,
      toolUseID,
      requestId: `req_${this.toolCounter}`,
      // biome-ignore lint/suspicious/noExplicitAny: `CanUseTool`'s options type isn't exported standalone by the SDK; this mirrors permissionHandler.test.ts's own `makeOptions()` cast.
    } as any);

    void pending
      .then((result) => {
        if (this.activeAbort === controller) this.activeAbort = undefined;
        this.emitToolLifecycle(toolUseID, name, args, result);
      })
      .catch(() => {
        if (this.activeAbort === controller) this.activeAbort = undefined;
        // Aborted (interrupt()) — `handleInterrupt` already emitted turn-end{cancelled}.
      });

    return pending;
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
    // `CanUseTool`'s SDK-declared return type is `PermissionResult | null`,
    // but `PermissionHandler.canUseTool` (the real implementation behind
    // it) never actually resolves `null` — every code path returns a
    // concrete `{behavior: 'allow'|'deny', ...}`. Treat a `null` here as the
    // real bug it would be (design principle: no silent failures) rather
    // than quietly skipping the tool-lifecycle envelopes.
    if (result === null) {
      throw new Error(
        `emitToolLifecycle: canUseTool resolved null for "${name}" — expected a PermissionResult`,
      );
    }
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
