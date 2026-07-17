/**
 * Remote-mode session over ACP (design §7.4 "Remote mode (v0.3 — ACP)",
 * plan.md §17 "Phase 2.2 — Claude remote on ACP"). The v2 successor to
 * `remote/claudeRemote.ts` (deleted in the same change that wires this in):
 * the same handle shape the launcher drives — `send`/`interrupt`/`setMode`/
 * `resolvePermission`/`stop` — but the transport underneath is the managed
 * ACP adapter child (`AcpConnection`) instead of a direct Claude Agent SDK
 * `query()`.
 *
 * What maps where (v1 → v2):
 *  - `query({prompt: PushableAsyncIterable})` spanning many turns
 *    → one `session/new` + one `session/prompt` request PER user turn,
 *      drained sequentially off an internal queue (`AcpConnection.prompt`
 *      enforces one in-flight prompt per session — ACP's own model).
 *  - `systemPrompt: {preset:'claude_code', append}` / `resume` / `model` /
 *    `permissionMode` → `session/new` `_meta.systemPrompt` +
 *    `_meta.claudeCode.options.{resume,model,permissionMode}` (verified: the
 *    adapter spreads `_meta.claudeCode.options` wholesale into SDK options).
 *  - `canUseTool` permission callback → `session/request_permission` server
 *    request → `AcpPermissionHandler` (same §7.6 pipeline surface:
 *    `resolvePermission` is first-wins for the `perm.answer` RPC).
 *  - (v1) SDK message stream → `SdkToEnvelopeConverter` becomes
 *    (v2) `session/update` notifications → `acpToEnvelope` mapper (text
 *      coalescing + deferred tool-start), with `turn-start`/`turn-end`
 *      synthesized around each `session/prompt` call/return.
 *  - `sdkQuery.interrupt()` → `session/cancel`; the adapter answers the
 *    in-flight prompt with `stopReason: 'cancelled'` (a normal response, not
 *    an error) → `turn-end{cancelled}`.
 *  - The SDK's `session_id` → the ACP `sessionId`, which IS the Claude Code
 *    session UUID (design §7.4) — reported once via `onProviderSessionId`
 *    and returned from `stop()` for the remote→local `claude --resume <id>`
 *    handoff.
 *
 * ## Send-idempotency hook (design §7.10)
 * `onTurnSettled` fires with the originating message's id when — and only
 * when — its `session/prompt` request RESOLVED (any stopReason: the turn
 * verifiably ran to a terminal state). A rejected prompt (adapter died,
 * connection closed) deliberately does NOT fire it: the outcome is
 * indeterminate and the caller's claim must stay open so a retried send
 * reports `outcome-unknown` instead of silently re-running the turn —
 * mobvibe's `executeMessageSend` rule, kept exactly.
 *
 * ## Mode-id mapping
 * Verified against the installed adapter: its ACP session-mode ids are
 * literally the four wire `PermissionMode` strings (`default`/`acceptEdits`/
 * `plan`/`bypassPermissions`), so `setMode` passes them through unchanged.
 * (`bypassPermissions` may be refused agent-side when running as root — the
 * error is logged, not thrown, same as v1's best-effort mode sync.)
 *
 * ## Known v2 delta: AskUserQuestion
 * The adapter disables the `AskUserQuestion` tool when the client doesn't
 * advertise form-elicitation capability (Falcon doesn't yet — see
 * `ACP_CLIENT_CAPABILITIES`). The model falls back to asking questions as
 * plain transcript text answered via the composer — functional, just not a
 * structured card. v1's structured flow depended on `updatedInput`, which
 * ACP's permission outcome cannot carry either way. Revisit with elicitation
 * support if the UX gap matters in practice.
 */
import type { PermissionMode, SessionEnvelope } from "@falcon/wire";
import { createEnvelope } from "@falcon/wire";
import { FALCON_SYSTEM_PROMPT } from "../claude/claudeLocal.js";
import type { Logger } from "../logger.js";
import { OrderedEnvelopeQueue } from "../remote/outgoingQueue.js";
import type { AcpConnectionError, PermissionRequestHandler } from "./acpConnection.js";
import { AcpConnection } from "./acpConnection.js";
import type { PermAnswerResult } from "./acpPermissionHandler.js";
import { AcpPermissionHandler } from "./acpPermissionHandler.js";
import type { AcpSessionUpdate, SessionTurnEndStatus } from "./acpToEnvelope.js";
import {
  closeAcpTurnWithStatus,
  createAcpEnvelopeMapperState,
  endAcpTurn,
  mapAcpStopReasonToTurnStatus,
  mapAcpUpdateToEnvelopes,
  startAcpTurn,
} from "./acpToEnvelope.js";

export interface AcpRemoteOptions {
  /** cwd for the ACP session (must exist — the adapter validates it). */
  workingDirectory: string;
  /** Provider session id to resume, or null/undefined for a fresh session. */
  resume?: string | null;
  permissionMode: PermissionMode;
  model?: string;
  /** `~/.falcon` (or override) — for the adapter manager's verify-before-spawn. */
  homeDir: string;
  /** Every envelope this session produces, already strict-ordered. */
  onEnvelopes: (envelopes: SessionEnvelope[]) => void;
  /** Fires once with the ACP session id (= provider session UUID). */
  onProviderSessionId?: (providerSessionId: string) => void;
  /** Fires when a turn's `session/prompt` RESOLVED — the claim-completion hook (file header). */
  onTurnSettled?: (info: { messageId?: string; status: SessionTurnEndStatus }) => void;
  logger?: Logger;
}

/** The narrow connection surface this module drives — `AcpConnection` satisfies it; tests inject fakes. */
export interface AcpRemoteConnection {
  connect(): Promise<void>;
  createSession(options: {
    cwd: string;
    meta?: Record<string, unknown> | null;
  }): Promise<{ sessionId: string }>;
  prompt(
    sessionId: string,
    prompt: { type: "text"; text: string }[],
  ): Promise<{ stopReason: string }>;
  cancel(sessionId: string): Promise<void>;
  setMode(sessionId: string, modeId: string): Promise<void>;
  disconnect(): Promise<void>;
  onSessionUpdate(listener: (notification: { update: unknown }) => void): () => void;
  onError(listener: (error: AcpConnectionError) => void): () => void;
  setPermissionHandler(handler: PermissionRequestHandler | undefined): void;
}

export interface AcpRemoteDeps {
  /** Injectable for tests; defaults to a real `AcpConnection` on the `claude-code` adapter. */
  createConnection?: (opts: { homeDir: string; logger?: Logger }) => AcpRemoteConnection;
  clientInfo?: { name: string; version: string };
}

export interface AcpRemoteHandle {
  /**
   * Pushes a new user turn — queued if a turn is in progress. `id`, when
   * given, becomes the emitted user envelope's id (the web Composer's
   * optimistic entry reconciles against it) AND the `onTurnSettled`
   * correlation key for claim completion.
   */
  send(prompt: string, id?: string): void;
  /** Cancels the in-flight turn (`session/cancel`) — it ends with `turn-end{cancelled}`. */
  interrupt(): Promise<void>;
  /** Syncs the live session's permission mode (`session/set_mode`) and the local handler. */
  setMode(mode: PermissionMode): Promise<void>;
  /** First-wins resolution for a pending `perm-request` (the `perm.answer` RPC). */
  resolvePermission(params: {
    reqId: string;
    decision: Parameters<AcpPermissionHandler["resolve"]>[0]["decision"];
  }): PermAnswerResult;
  /** Ends the session and closes the adapter child; resolves with the provider session id. */
  stop(): Promise<{ providerSessionId: string | null }>;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const DEFAULT_CLIENT_INFO = { name: "falcon", version: "0.0.0" };

interface QueuedTurn {
  text: string;
  id?: string;
}

/** Starts one ACP-backed remote session and returns the handle that drives it. */
export function startAcpRemote(opts: AcpRemoteOptions, deps: AcpRemoteDeps = {}): AcpRemoteHandle {
  const logger = opts.logger ?? noopLogger;
  const connection: AcpRemoteConnection =
    deps.createConnection?.({ homeDir: opts.homeDir, logger }) ??
    new AcpConnection({
      adapterId: "claude-code",
      homeDir: opts.homeDir,
      clientInfo: deps.clientInfo ?? DEFAULT_CLIENT_INFO,
      logger,
    });

  const mapperState = createAcpEnvelopeMapperState();
  const outgoing = new OrderedEnvelopeQueue({
    onFlush: (envelope) => opts.onEnvelopes([envelope]),
  });

  let providerSessionId: string | null = opts.resume ?? null;
  let stopped = false;
  let fatalError: string | null = null;

  const permissionHandler = new AcpPermissionHandler({
    emitEnvelope: (envelope) => outgoing.push(envelope),
    onModeChange: (mode) => {
      // A perm.answer decision switched modes — sync the live session, same
      // best-effort shape as v1's onModeChange → setPermissionMode.
      void setSessionMode(mode).catch((error: unknown) => {
        logger.debug("[acp-remote] failed to sync permission mode after decision", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    logger,
  });
  connection.setPermissionHandler((params, _requestId, signal) =>
    permissionHandler.handleRequest(params, signal),
  );

  connection.onSessionUpdate(({ update }) => {
    outgoing.pushAll(mapAcpUpdateToEnvelopes(update as AcpSessionUpdate, mapperState, logger));
  });

  connection.onError((error) => {
    if (stopped) return;
    fatalError = error.message;
    logger.error("[acp-remote] adapter connection failed", { error: error.message });
    // Close any open turn as failed and surface the failure on the timeline.
    outgoing.pushAll(closeAcpTurnWithStatus(mapperState, "failed"));
    outgoing.push(
      createEnvelope("agent", {
        t: "service",
        text: `Remote session lost its agent process: ${error.message}`,
      }),
    );
  });

  // Session startup — connect + session/new with the Claude meta payload
  // (design §7.4). `ready` is awaited by the turn drain; a startup failure
  // surfaces once as a service envelope and fails subsequent sends fast.
  const ready: Promise<string> = (async () => {
    await connection.connect();
    const session = await connection.createSession({
      cwd: opts.workingDirectory,
      meta: {
        systemPrompt: { type: "preset", preset: "claude_code", append: FALCON_SYSTEM_PROMPT },
        claudeCode: {
          options: {
            ...(opts.resume ? { resume: opts.resume } : {}),
            ...(opts.model ? { model: opts.model } : {}),
            permissionMode: opts.permissionMode,
          },
        },
      },
    });
    providerSessionId = session.sessionId;
    opts.onProviderSessionId?.(session.sessionId);
    return session.sessionId;
  })();
  ready.catch((error: unknown) => {
    if (fatalError) return; // onError already surfaced it (with stderr tail)
    fatalError = error instanceof Error ? error.message : String(error);
    logger.error("[acp-remote] failed to start ACP session", { error: fatalError });
    outgoing.push(
      createEnvelope("agent", {
        t: "service",
        text: `Remote session failed to start: ${fatalError}`,
      }),
    );
  });

  async function setSessionMode(mode: PermissionMode): Promise<void> {
    const sessionId = await ready;
    await connection.setMode(sessionId, mode); // mode ids are the wire modes (file header)
  }

  // --- sequential turn drain ---
  const turnQueue: QueuedTurn[] = [];
  let draining = false;
  let drainSettled: Promise<void> = Promise.resolve();

  function kickDrain(): void {
    if (draining) return;
    draining = true;
    drainSettled = drain().finally(() => {
      draining = false;
    });
  }

  async function drain(): Promise<void> {
    let sessionId: string;
    try {
      sessionId = await ready;
    } catch {
      turnQueue.length = 0; // startup failed — already surfaced; claims stay open (outcome-unknown)
      return;
    }
    while (turnQueue.length > 0 && !stopped && !fatalError) {
      const turn = turnQueue.shift();
      if (!turn) break;
      outgoing.push(startAcpTurn(mapperState));
      try {
        const result = await connection.prompt(sessionId, [{ type: "text", text: turn.text }]);
        outgoing.pushAll(endAcpTurn(mapperState, result.stopReason));
        opts.onTurnSettled?.({
          messageId: turn.id,
          status: mapAcpStopReasonToTurnStatus(result.stopReason),
        });
      } catch (error) {
        // Prompt REJECTED (adapter death / connection closed mid-turn): the
        // outcome is indeterminate — close the turn visually, but do NOT
        // fire onTurnSettled (file header: the claim must stay open).
        logger.error("[acp-remote] session/prompt failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        outgoing.pushAll(closeAcpTurnWithStatus(mapperState, stopped ? "cancelled" : "failed"));
      }
    }
  }

  function send(prompt: string, id?: string): void {
    if (stopped) {
      logger.debug("[acp-remote] dropping send after stop", { id });
      return;
    }
    // The human-typed prompt envelope is emitted here directly (the mapper
    // intentionally drops ACP's user_message_chunk echo — same rule as v1).
    outgoing.push(createEnvelope("user", { t: "text", md: prompt }, { id }));
    turnQueue.push({ text: prompt, id });
    kickDrain();
  }

  async function interrupt(): Promise<void> {
    const sessionId = await ready;
    await connection.cancel(sessionId);
  }

  async function setMode(mode: PermissionMode): Promise<void> {
    await setSessionMode(mode);
  }

  function resolvePermission(params: Parameters<AcpRemoteHandle["resolvePermission"]>[0]) {
    return permissionHandler.resolve(params);
  }

  async function stop(): Promise<{ providerSessionId: string | null }> {
    if (stopped) {
      await drainSettled;
      return { providerSessionId };
    }
    stopped = true;
    turnQueue.length = 0;

    try {
      const sessionId = await Promise.race([ready, Promise.resolve(null)]);
      if (sessionId) await connection.cancel(sessionId);
    } catch (error) {
      logger.debug("[acp-remote] cancel during stop failed (ignored)", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Any perm-request still awaiting an answer must settle, not hang
    // against a handler nobody can reach once this session is gone.
    permissionHandler.reset("Session stopped");

    await drainSettled;
    outgoing.pushAll(closeAcpTurnWithStatus(mapperState, "cancelled"));
    outgoing.flush();
    await connection.disconnect();
    outgoing.dispose();

    return { providerSessionId };
  }

  return { send, interrupt, setMode, resolvePermission, stop };
}
