/**
 * Wires `CodexAppServerClient` + `CodexPermissionHandler` +
 * `mapCodexEventToEnvelopes` into one cohesive session-scoped handle — the
 * Codex parallel to `../remote/claudeRemote.ts` (design §7.7: "Thread
 * lifecycle: `newConversation`/`resumeConversation`; events mapped by
 * `codexEnvelopeMapper`").
 *
 * Scope note, same as `claudeRemote.ts`'s own: this module owns exactly one
 * Codex thread's lifecycle (send/interrupt/setMode/resolvePermission/stop)
 * plus the client -> envelope pipeline. The orchestration that decides WHEN
 * to construct one of these (the `falcon codex` entrypoint wiring it to a
 * real outbox/session-RPC transport) is `loop.ts`-equivalent work that
 * hasn't landed for Claude's own remote mode yet either (see
 * `claudeRemote.ts`'s file header) — deliberately out of scope here too.
 */
import {
  createEnvelope,
  type PermDecision,
  type PermissionMode,
  type SessionEnvelope,
} from "@falcon/wire";
import type { Logger } from "../logger.js";
import { OrderedEnvelopeQueue } from "../remote/outgoingQueue.js";
import { type ApprovalHandler, CodexAppServerClient } from "./codexAppServerClient.js";
import type { ApprovalPolicy, ReasoningEffort, SandboxMode } from "./codexAppServerTypes.js";
import {
  closeCodexTurnWithStatus,
  createCodexEnvelopeMapperState,
  mapCodexEventToEnvelopes,
} from "./envelopeMapper.js";
import { CodexPermissionHandler, type PermAnswerResult } from "./permissionHandler.js";

export interface CodexRemoteOptions {
  /** cwd for the spawned `codex app-server` process. */
  workingDirectory: string;
  /** Codex thread id to resume, or undefined to start a fresh thread. */
  resume?: string;
  permissionMode: PermissionMode;
  model?: string;
  effort?: ReasoningEffort;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  /** Every envelope this thread produces, already strict-ordered. */
  onEnvelopes: (envelopes: SessionEnvelope[]) => void;
  /** Fires once the thread id is known (fresh start or resume) — Codex's analogue of `providerSessionId` (design §6.7). */
  onThreadId?: (threadId: string) => void;
  logger?: Logger;
}

export interface CodexRemoteHandle {
  send(prompt: string): Promise<void>;
  interrupt(): Promise<void>;
  setMode(mode: PermissionMode): void;
  resolvePermission(params: { reqId: string; decision: PermDecision }): PermAnswerResult;
  stop(): Promise<{ threadId: string | null }>;
}

export interface CodexRemoteDeps {
  /** Injectable for tests; defaults to a real `CodexAppServerClient`. */
  client?: CodexAppServerClient;
  logger?: Logger;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Starts one Codex thread and returns a handle to drive it. */
export async function startCodexRemote(
  opts: CodexRemoteOptions,
  deps: CodexRemoteDeps = {},
): Promise<CodexRemoteHandle> {
  const logger = deps.logger ?? opts.logger ?? noopLogger;
  const client = deps.client ?? new CodexAppServerClient({ logger });

  const mapperState = createCodexEnvelopeMapperState();
  const outgoing = new OrderedEnvelopeQueue({
    onFlush: (envelope) => opts.onEnvelopes([envelope]),
  });

  const permissionHandler = new CodexPermissionHandler({
    initialMode: opts.permissionMode,
    emitEnvelope: (envelope) => outgoing.push(envelope),
    logger,
  });

  client.setApprovalHandler(permissionHandler.handleApproval satisfies ApprovalHandler);
  client.setEventHandler((msg) => {
    outgoing.pushAll(mapCodexEventToEnvelopes(msg, mapperState));
  });

  await client.connect();

  let threadId: string;
  if (opts.resume) {
    const result = await client.resumeThread({
      threadId: opts.resume,
      model: opts.model,
      cwd: opts.workingDirectory,
      approvalPolicy: opts.approvalPolicy,
      sandbox: opts.sandbox,
    });
    threadId = result.threadId;
  } else {
    const result = await client.startThread({
      model: opts.model,
      cwd: opts.workingDirectory,
      approvalPolicy: opts.approvalPolicy,
      sandbox: opts.sandbox,
    });
    threadId = result.threadId;
  }
  opts.onThreadId?.(threadId);

  let stopped = false;

  async function send(prompt: string): Promise<void> {
    outgoing.pushAll(closeCodexTurnWithStatus(mapperState, "completed"));
    outgoing.push(createEnvelope("user", { t: "text", md: prompt }));
    await client.sendTurn(prompt, {
      model: opts.model,
      cwd: opts.workingDirectory,
      effort: opts.effort,
    });
  }

  async function interrupt(): Promise<void> {
    await client.interruptTurn();
  }

  function setMode(mode: PermissionMode): void {
    permissionHandler.setMode(mode);
  }

  function resolvePermission(params: { reqId: string; decision: PermDecision }): PermAnswerResult {
    return permissionHandler.resolve(params);
  }

  async function stop(): Promise<{ threadId: string | null }> {
    if (stopped) return { threadId };
    stopped = true;

    await client.interruptTurn();
    permissionHandler.reset("Session stopped");
    outgoing.pushAll(closeCodexTurnWithStatus(mapperState, "cancelled"));
    outgoing.flush();

    await client.disconnect();
    outgoing.dispose();

    return { threadId };
  }

  return { send, interrupt, setMode, resolvePermission, stop };
}
