/**
 * `falcon claude [args...]` (plan.md §16 "1.3 CLI skeleton + local mode" /
 * "2.2 Mode switching"; plan.md §17) — the first real (non-stub) provider
 * spawn. Every piece this wires together already existed and was already
 * unit-tested in isolation (`session/bootstrap.ts`, `api/outbox.ts`,
 * `claude/loop.ts` + `claude/ptyClaudeSession.ts`,
 * `claude/remotePermissionHook.ts`, `provider/claudeCliLocator.ts`,
 * `session/sessionClient.ts`, `rpc/sessionRpc.ts`) — nothing here is new
 * logic, only composition. Codex has no local-interactive mode
 * (`codex/index.ts`'s `CODEX_NO_LOCAL_MODE_NOTE`), so `index.ts`'s `runStart`
 * only reaches this module for `provider === "claude"`; every other provider
 * keeps going through the honest `describeStart` stub.
 *
 * This module opens the session-scoped `/v1/stream` connection
 * (`session/sessionClient.ts`) and registers the five session RPCs
 * (`rpc/sessionRpc.ts`) over it, so a `message`/`takeControl`/`perm.answer`
 * sent from the web UI actually reaches the running session: previously these
 * were no-op stubs and nothing on the CLI side ever joined the
 * `s:<sessionId>:<method>` room the server's relay looks up (the "RPC target
 * not available" web error).
 *
 * ## Two flows (`detectStartingMode()` picks the branch)
 *
 * v3 (PTY injection — the omnara model): a human-run, terminal-attached
 * `falcon claude` no longer drives the local↔remote mode-switch loop at all.
 * It runs `claude` on a pseudo-terminal (`ptyClaudeSession.ts`): the normal
 * TUI stays live, and a web-sent `message` is TYPED INTO that same PTY when
 * the session is idle — no mode switch, no process kill, no Ink takeover.
 * Remote answering of the live TUI's tool-permission prompts (design §7.4/
 * §7.6) rides on a SINGLE hook server installed here via
 * `installRemotePermissionHook()`, which owns all five Claude Code hooks
 * (`SessionStart`/`Notification`/`Stop`/`PreToolUse`/`PermissionRequest` —
 * `PreToolUse` always defers to Claude Code's own permission engine;
 * `PermissionRequest` is where the web-vs-terminal fork actually lives,
 * plan-v2.md Wave 1.1). Its `settingsEnv`/
 * `settingsPath` are handed to the PTY session (so the spawned `claude` gets
 * `--settings`), its `onSessionId` is routed to the PTY tailer, its
 * `resolvePermission` backs the `perm.answer` RPC, and `markWebTurnStart()`
 * fires the moment a web message is actually submitted into the PTY so that
 * turn's `PreToolUse` prompts route to the web PermCard (a locally-typed turn
 * shows the normal terminal prompt and clears it immediately via
 * `markLocalActivity()`, plan-v2.md W1.2; `markTurnEnd()` is fired
 * automatically by the composition off Claude Code's own `Stop` hook, and a
 * `WEB_TURN_MAX_MS` watchdog self-heals a flag left stuck by a missed `Stop`
 * hook). A web message is only ever typed in when the PTY session's
 * injection gate is idle AND no TUI dialog is known to be open
 * (`setPromptOpen`, fed by `onAttention`/`onPromptLikely` and cleared by the
 * tailer's next `tool-end` envelope or a 120s failsafe — plan-v2.md W1.3).
 * `interrupt` sends the TUI's own Escape cancel gesture (plan-v2.md W1.5);
 * `setMode` stays honestly not-supported on this path — the live TUI owns its
 * own permission mode.
 *
 * The legacy `loop()` path (with the ACP remote transport) is kept ONLY for
 * the daemon-spawned, no-terminal `falcon claude --starting-mode remote`
 * flow, which genuinely starts headless and has no live TUI: there
 * `interrupt`/`setMode`/`perm.answer` reach the live remote turn via
 * `loop()`'s `onRemoteActive`, and there is no PTY injection and no hook
 * server (ACP owns permissions agent-side).
 *
 * Send idempotency (design §7.10): the `message` RPC claims `(sessionId,
 * envelopeId)` in the on-disk claim store BEFORE emitting — a duplicate
 * whose claim already completed replies `duplicate`, one whose claim exists
 * with no result (crash mid-turn) replies `outcome-unknown`, and a fresh
 * claim is completed when the send settles (the PTY path completes it on
 * `onInjected` — the moment the message is typed + submitted; the remote path
 * on `onTurnSettled`). A retried RPC can never run the agent twice for one
 * logical send.
 */
import path from "node:path";
import { decodeBase64, deriveKeyTree } from "@falcon/crypto";
import type { PermissionMode } from "@falcon/wire";
import { createId } from "@paralleldrive/cuid2";
import { createHttpClient } from "../api/httpClient.js";
import { Outbox } from "../api/outbox.js";
import { resolveBackendUrl } from "../auth/config.js";
import {
  type FalconCredentials,
  readCredentials as readCredentialsDefault,
} from "../auth/credentials.js";
import { claimMessageSend, completeMessageSend } from "../claims/claimStore.js";
import type { ClaudeLocalLauncherDeps } from "../claude/claudeLocalLauncher.js";
import type { ClaudeRemoteLauncherDeps } from "../claude/claudeRemoteLauncher.js";
import {
  type ClaudeMode,
  type LoopDeps,
  type LoopOptions,
  loop as loopDefault,
  type QueuedMessage,
  type RemoteControls,
} from "../claude/loop.js";
import {
  type PtyClaudeSessionHandle,
  startPtyClaudeSession as startPtyClaudeSessionDefault,
} from "../claude/ptyClaudeSession.js";
import {
  defaultHooksDir,
  installRemotePermissionHook as installRemotePermissionHookDefault,
  type RemotePermissionHookHandle,
} from "../claude/remotePermissionHook.js";
import { type DaemonState, readDaemonState as readDaemonStateDefault } from "../daemon/state.js";
import type { Logger } from "../logger.js";
import {
  type ClaudeCliLocation,
  findGlobalClaudeCliPath as findGlobalClaudeCliPathDefault,
} from "../provider/claudeCliLocator.js";
import { CLAUDE_NOT_INSTALLED_MESSAGE } from "../provider/claudeProviderAdapter.js";
import { registerSessionRpcHandlers, type SessionRpcHandlers } from "../rpc/sessionRpc.js";
import {
  bootstrapSession as bootstrapSessionDefault,
  createBootstrapSessionDeps,
} from "../session/bootstrap.js";
import {
  createSessionClientDeps,
  startSessionClient as startSessionClientDefault,
} from "../session/sessionClient.js";

const MASTER_SECRET_LENGTH_BYTES = 32;
const NOT_LOGGED_IN_MESSAGE = 'falcon: not logged in — run "falcon auth login" first\n';

// The daemon persists `machineId` to `daemon.state.json` only once its own
// (async, network-bound) machine registration completes — see
// `machineIntegration.ts` — which can land a beat after `ensureDaemon()`
// above already returned (that call only waits for the control port, not
// for machine registration). A short bounded wait here covers the common
// "just logged in, this is the very first `falcon claude`" race without
// turning into an unbounded retry loop.
const MACHINE_ID_WAIT_TIMEOUT_MS = 3000;
const MACHINE_ID_POLL_MS = 100;

export interface StartClaudeCommandDeps {
  homeDir: string;
  workingDirectory: string;
  claudeArgs: string[];
  /** Resolved path to `scripts/falcon_claude_launcher.cjs` — see `index.ts`'s `resolveClaudeLauncherPath()`. */
  launcherPath: string;
  env?: NodeJS.ProcessEnv;
  backendUrl?: string;
  /** Injectable for tests; defaults to `auth/credentials.ts`'s real, `~/.falcon/access.key`-backed reader. */
  readCredentials?: (homeDir: string) => FalconCredentials | null;
  /** Injectable for tests; defaults to `daemon/state.ts`'s real `daemon.state.json` reader. */
  readDaemonState?: (homeDir: string) => Promise<DaemonState | null>;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the real cross-install-method locator. */
  locateClaudeCli?: (env: NodeJS.ProcessEnv) => ClaudeCliLocation | null;
  /** Injectable for tests; defaults to the real `bootstrapSession()`. */
  bootstrapSession?: typeof bootstrapSessionDefault;
  /** Injectable for tests; defaults to the real mode loop (only reached on the `--starting-mode remote` branch). */
  loop?: (options: LoopOptions, loopDeps: LoopDeps) => Promise<number>;
  /** Injectable for tests; defaults to the real PTY-injection session (the terminal-attached flow). */
  startPtyClaudeSession?: typeof startPtyClaudeSessionDefault;
  /**
   * Injectable for tests; defaults to the real remote-permission hook
   * installer (the single hook server owning all four hooks —
   * `claude/remotePermissionHook.ts`). Only installed on the terminal PTY
   * flow; the headless `--starting-mode remote` flow uses ACP's own
   * agent-side permission pipeline instead.
   */
  installRemotePermissionHook?: typeof installRemotePermissionHookDefault;
  /** Injectable for tests; defaults to the real `startSessionClient()`. */
  startSessionClient?: typeof startSessionClientDefault;
  /** Injectable for tests; defaults to the real `registerSessionRpcHandlers()`. */
  registerSessionRpcHandlers?: typeof registerSessionRpcHandlers;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
  logger?: Logger;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * A minimal `Set<handler>`-backed pub-sub — the local half of the
 * `message`/`takeControl` session RPCs' path into `loop()`'s `onMessage`/
 * `onTakeControl` registration functions (see `loop.ts`'s own doc comment
 * on those options: "a session RPC/keypress layer ... wires the real
 * transport into these three callback-registration functions"). `loop()`
 * itself only ever registers one handler per signal for its whole run, but
 * a `Set` costs nothing extra and doesn't assume that stays true.
 */
function createSignal<T>(): {
  subscribe: (handler: (value: T) => void) => () => void;
  emit: (value: T) => void;
} {
  const handlers = new Set<(value: T) => void>();
  return {
    subscribe: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit: (value) => {
      for (const handler of handlers) handler(value);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits (briefly) for the daemon to have persisted a `machineId`. Returns
 * `null` on timeout rather than throwing — the caller turns that into an
 * honest, actionable error instead of a stack trace.
 */
async function waitForMachineId(
  homeDir: string,
  deps: {
    readDaemonState: (homeDir: string) => Promise<DaemonState | null>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
  },
): Promise<string | null> {
  const deadline = deps.now() + MACHINE_ID_WAIT_TIMEOUT_MS;
  for (;;) {
    const state = await deps.readDaemonState(homeDir);
    if (state?.machineId) return state.machineId;
    if (deps.now() >= deadline) return null;
    await deps.sleep(MACHINE_ID_POLL_MS);
  }
}

/** Runs `falcon claude [args...]`. Returns the process exit code. */
export async function runStartClaudeCommand(deps: StartClaudeCommandDeps): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const writeError = deps.writeError ?? ((text: string) => process.stderr.write(text));
  const logger = deps.logger ?? noopLogger;
  const env = deps.env ?? process.env;
  const readCreds = deps.readCredentials ?? readCredentialsDefault;
  const readState = deps.readDaemonState ?? readDaemonStateDefault;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const locate = deps.locateClaudeCli ?? findGlobalClaudeCliPathDefault;
  const doBootstrapSession = deps.bootstrapSession ?? bootstrapSessionDefault;
  const startSessionClient = deps.startSessionClient ?? startSessionClientDefault;
  const registerRpc = deps.registerSessionRpcHandlers ?? registerSessionRpcHandlers;

  // 1. Never touch the network without credentials (no silent failures).
  const credentials = readCreds(deps.homeDir);
  if (!credentials) {
    writeError(NOT_LOGGED_IN_MESSAGE);
    return 1;
  }

  // 9. Fail honestly, not silently, when the real `claude` CLI can't be found.
  const location = locate(env);
  if (!location) {
    writeError(`falcon claude: ${CLAUDE_NOT_INSTALLED_MESSAGE}\n`);
    return 1;
  }
  // Capture the narrowed path in a plain const — the null-guard's narrowing of
  // `location` does not carry into the nested run* closures below.
  const claudeCliPath = location.path;

  const masterSecret = decodeBase64(credentials.masterSecretOrContentBundle);
  if (masterSecret.length !== MASTER_SECRET_LENGTH_BYTES) {
    // Mirrors `machineIntegration.ts`'s own same guard: a reduced-custody
    // pairing bundle (rather than a full masterSecret) can't derive a
    // content keypair the same way — honest failure, not a wrong-key crash.
    writeError(
      "falcon claude: stored credentials can't derive a content key for local sessions (reduced-custody pairing?) — run `falcon auth login` on this machine\n",
    );
    return 1;
  }
  const { content: contentKeyPair } = deriveKeyTree(masterSecret);

  // 3. Reuse the daemon's own machineId — `ensureDaemon()` (already run by
  // the caller) guarantees a daemon is up, but not that it's finished
  // registering a machine yet (see `waitForMachineId`'s doc comment).
  const machineId = await waitForMachineId(deps.homeDir, {
    readDaemonState: readState,
    sleep: deps.sleep ?? sleep,
    now: deps.now ?? Date.now,
  });
  if (!machineId) {
    writeError(
      "falcon claude: this machine hasn't finished registering with the Falcon server yet — try again in a few seconds (see `falcon daemon status`)\n",
    );
    return 1;
  }

  const backendUrl = deps.backendUrl ?? resolveBackendUrl(env);

  // 4. Bootstrap (create-or-get) the session row + its DEK.
  let bootstrap: Awaited<ReturnType<typeof bootstrapSessionDefault>>;
  try {
    bootstrap = await doBootstrapSession(
      createBootstrapSessionDeps({
        serverUrl: backendUrl,
        fetchImpl,
        getAuthToken: () => credentials.token,
        logger,
      }),
      {
        machineId,
        workspacePath: deps.workingDirectory,
        nonce: createId(),
        provider: "claude-code",
        contentKeyPair,
        metadata: {
          title: path.basename(deps.workingDirectory) || deps.workingDirectory,
          path: deps.workingDirectory,
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[start-claude] bootstrapSession failed", { message });
    writeError(`falcon claude: failed to start session — ${message}\n`);
    return 1;
  }

  write(`falcon claude: starting session ${bootstrap.sessionId}\n`);

  // 5. Outbox mirrors every transcript envelope to the server; disposed
  // (buffered-but-unsealed envelopes flushed to the on-disk queue, not
  // necessarily sent) once the local session ends.
  const outbox = new Outbox({
    sessionId: bootstrap.sessionId,
    dek: bootstrap.dek,
    http: createHttpClient({
      serverUrl: backendUrl,
      headers: { authorization: `Bearer ${credentials.token}` },
      fetchImpl,
    }),
    homeDir: deps.homeDir,
    logger,
  });

  // The session-scoped `/v1/stream` connection `message`/`interrupt`/
  // `takeControl`/`setMode`/`perm.answer` arrive over (design §4.4). Without
  // this, nothing on the CLI side ever joins the `s:<sessionId>:<method>`
  // room the server's RPC relay looks up.
  const sessionClient = startSessionClient(
    createSessionClientDeps(
      { serverUrl: backendUrl, token: credentials.token, sessionId: bootstrap.sessionId },
      { logger },
    ),
  );

  // Send-idempotency claim bookkeeping (design §7.10): envelopeId -> claimId,
  // so the completion hook can complete exactly the claim its `message`
  // handler opened. Cleared once completed. Shared by both flows.
  const openClaims = new Map<string, string>();
  const completeClaim = (messageId: string, result: unknown): void => {
    const claimId = openClaims.get(messageId);
    if (!claimId) return;
    openClaims.delete(messageId);
    void completeMessageSend(bootstrap.sessionId, messageId, claimId, result, {
      homeDir: deps.homeDir,
    }).catch((error: unknown) => {
      logger.warn("[start-claude] failed to complete send claim", {
        id: messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  // Claim a send BEFORE it reaches the agent — a retried/duplicated RPC must
  // never run the agent twice (design §7.10). Returns either the text to
  // deliver (fresh claim) or the honest tri-state RPC response to send back.
  type MessageEnvelope = Parameters<SessionRpcHandlers["message"]>[0]["envelope"];
  type MessageResult = Awaited<ReturnType<SessionRpcHandlers["message"]>>;
  const beginSend = async (
    envelope: MessageEnvelope,
  ): Promise<{ proceed: true; text: string } | { proceed: false; response: MessageResult }> => {
    if (envelope.ev.t !== "text") {
      logger.warn("[start-claude] message RPC delivered a non-text envelope; dropping", {
        type: envelope.ev.t,
      });
      return { proceed: false, response: { queued: false } };
    }
    const text = envelope.ev.md;
    const claim = await claimMessageSend(bootstrap.sessionId, envelope.id, {
      homeDir: deps.homeDir,
    });
    if (claim.status === "completed") {
      logger.debug("[start-claude] message RPC replay — claim already completed", {
        id: envelope.id,
      });
      return { proceed: false, response: { queued: false, status: "duplicate" } };
    }
    if (claim.status === "in-progress") {
      logger.warn("[start-claude] message RPC outcome indeterminate — open claim, not re-running", {
        id: envelope.id,
      });
      return { proceed: false, response: { queued: false, status: "outcome-unknown" } };
    }
    openClaims.set(envelope.id, claim.claimId);
    return { proceed: true, text };
  };

  /**
   * The terminal-attached flow (the common human-run `falcon claude`): run
   * `claude` on a PTY and type web messages into it. No mode switch ever.
   *
   * Installs the SINGLE hook server (`installRemotePermissionHook()`, owning
   * all four Claude Code hooks) and hands the PTY session its
   * `settingsPath`/`settingsEnv` (so the spawned `claude` gets `--settings`
   * and all four hooks fire) and routes its `onSessionId` into the PTY
   * tailer. `perm.answer` routes to the hook bridge; a web message being
   * submitted (`onInjected`) marks the turn web-initiated so its `PreToolUse`
   * prompts route to the web PermCard.
   */
  async function runLocalPty(): Promise<number> {
    const runPtySession = deps.startPtyClaudeSession ?? startPtyClaudeSessionDefault;
    const installRemotePermHook =
      deps.installRemotePermissionHook ?? installRemotePermissionHookDefault;

    // Assigned right below; the hook server's `onSessionId` (installed first)
    // forwards the real provider session id into it once the TUI reports it.
    let ptyHandle: PtyClaudeSessionHandle | null = null;

    // The one hook server for this session. A failure here is non-fatal: the
    // session still starts (the terminal TUI's own prompts still work), just
    // without remote permission answering this run.
    let permHook: RemotePermissionHookHandle | null = null;
    try {
      permHook = await installRemotePermHook({
        hooksDir: defaultHooksDir(deps.homeDir),
        emitEnvelope: (envelope) => outbox.enqueue([envelope]),
        onSessionId: (id) => {
          logger.debug("[start-claude] provider session id from SessionStart hook", { id });
          ptyHandle?.notifyProviderSessionId(id);
        },
        // "perm"/"question" mean Claude Code is showing (or about to show) a
        // TUI dialog at the terminal — gate injection so a queued web
        // message never gets typed into it; "done" (the Stop hook) means the
        // turn ended, clearing the gate. See `onEnvelopes` below for the
        // other, more precise clearing signal (a `tool-end` envelope).
        //
        // The Notification hook fires from Claude Code itself and can't tell
        // us whether a TUI dialog actually rendered — during an active web
        // turn, `PermissionRequest` is already answered remotely (the bridge's
        // local-vs-web fork) and no dialog appears, so gate opening on
        // "perm"/"question" is skipped while `isWebTurnActive()` is true,
        // mirroring the bridge's own `onPromptLikely` (local-turn-only).
        // "done" still always clears the gate unconditionally — the turn
        // ending is safe to reflect regardless of who started it.
        onAttention: (kind) => {
          logger.debug("[start-claude] attention from hook", { kind });
          if ((kind === "perm" || kind === "question") && !permHook?.isWebTurnActive()) {
            ptyHandle?.setPromptOpen(true);
          }
          if (kind === "done") ptyHandle?.setPromptOpen(false);
        },
        // The bridge's local-turn path (a dialog may be about to render at
        // the terminal) — the earlier, less certain half of the same gate.
        onPromptLikely: () => ptyHandle?.setPromptOpen(true),
        logger,
      });
    } catch (error) {
      logger.warn("[start-claude] remote permission hook unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const ptySession: PtyClaudeSessionHandle = runPtySession(
      {
        workingDirectory: deps.workingDirectory,
        launcherPath: deps.launcherPath,
        claudeCliPath: claudeCliPath,
        claudeArgs: deps.claudeArgs,
        providerSessionId: null,
        homeDir: deps.homeDir,
        env,
        // The single shared hook server's `--settings` file + env — so the
        // PTY-spawned `claude` fires all four hooks. Null when install failed.
        settingsPath: permHook?.settingsPath ?? null,
        settingsEnv: permHook?.settingsEnv,
        onEnvelopes: (envelopes) => {
          // The tailer's next tool-result is the precise "the dialog that was
          // open is gone" signal — clears the gate the attention/onPromptLikely
          // wiring above set (plan-v2.md W1.3).
          if (envelopes.some((e) => e.ev.t === "tool-end")) ptyHandle?.setPromptOpen(false);
          outbox.enqueue(envelopes);
        },
        // The send-claim completes the moment the message is actually typed +
        // submitted into the PTY — from there a retry is an honest duplicate.
        // That same submit is the "a web turn just began" signal: mark it so
        // this turn's `PreToolUse` prompts route to the web PermCard.
        onInjected: (id) => {
          completeClaim(id, { status: "injected" });
          permHook?.markWebTurnStart();
        },
        // A locally-typed Enter at the real keyboard is the human reclaiming
        // the turn — clear the web-turn flag immediately (plan-v2.md W1.2).
        onLocalSubmit: () => permHook?.markLocalActivity(),
        logger,
      },
      { logger },
    );
    ptyHandle = ptySession;

    const rpcHandlers: SessionRpcHandlers = {
      message: async ({ envelope }) => {
        const begin = await beginSend(envelope);
        if (!begin.proceed) return begin.response;
        ptySession.injectMessage({ id: envelope.id, text: begin.text });
        return { queued: true, status: "queued" };
      },
      // The human is already at this terminal — "take control" is a no-op that
      // succeeds (there is no remote turn to reclaim from).
      takeControl: async () => ({ ok: true }),
      // Escape is safe to send regardless of TUI state: mid-turn it cancels
      // the turn, at an idle prompt it's a no-op, inside a menu it closes the
      // menu (recoverable) — plan-v2.md W1.5.
      interrupt: async () => ({ ok: ptySession.sendInterrupt() }),
      // The live TUI owns its own permission mode; there is no remote turn to
      // retune. Honest not-supported, never faked.
      setMode: async () => ({ ok: false }),
      // Remote answering of the live TUI's tool-permission prompt (design
      // §7.6): route into the `PreToolUse` hook bridge (first-wins). Only when
      // the hook server failed to install is this honestly not-supported.
      permAnswer: async ({ reqId, decision }) => {
        if (permHook) return permHook.resolvePermission({ reqId, decision });
        logger.debug("[start-claude] perm.answer RPC — no live permission hook to route to");
        return { ok: false };
      },
      // "End session" from the web (plan-v2.md W2.3): SIGTERM the PTY child.
      // Status reporting ("ended", landing BEFORE the WS drops so a stop that
      // races the disconnect still surfaces) is deliberately not wired here —
      // the server's `POST /v1/sessions/:id/status` route only accepts
      // `status: "failed"` today (plan-v2.md U1.4 "lifecycle-status", not yet
      // landed on this branch, adds the additive `"ended"` transition); firing
      // it now would either be rejected or mislabel a clean stop as a crash.
      // `force` doesn't SIGKILL the child directly — `ptyProcess.kill()` has
      // no signal override yet — it instead exits this whole CLI process
      // after a short grace period so a hung child can't block the "web says
      // stopped" outcome the user asked for.
      stop: async ({ force }) => {
        logger.info("[start-claude] stop requested from web", { force: force ?? false });
        ptySession.stop();
        if (force) setTimeout(() => process.exit(0), 3000).unref();
        return { ok: true };
      },
    };
    const rpcHandle = registerRpc({
      sessionId: bootstrap.sessionId,
      dek: bootstrap.dek,
      socket: sessionClient.socket,
      handlers: rpcHandlers,
      logger,
    });

    try {
      return await ptySession.done;
    } finally {
      ptySession.stop();
      rpcHandle.stop();
      if (permHook) await permHook.stop();
    }
  }

  /**
   * The daemon-spawned, no-terminal flow (`--starting-mode remote`): keep the
   * headless local↔remote `loop()` with the ACP remote transport. A terminal
   * session never reaches this — it uses the PTY path above. No hook server /
   * PTY injection here: ACP owns permissions agent-side, and
   * `interrupt`/`setMode`/`perm.answer` reach the live remote turn via
   * `onRemoteActive`.
   */
  async function runRemoteLoop(): Promise<number> {
    const runLoop = deps.loop ?? loopDefault;
    const localLauncherDeps: ClaudeLocalLauncherDeps = { launcherPath: deps.launcherPath, logger };
    // Defaults-only, but a real object — a mid-run switch calls
    // `startClaudeRemoteLauncher(..., deps.remote)`.
    const remoteLauncherDeps: ClaudeRemoteLauncherDeps = {};
    const permissionMode: PermissionMode = "default";

    const messageSignal = createSignal<QueuedMessage>();
    const takeControlSignal = createSignal<void>();
    const exitSignal = createSignal<void>();
    let currentMode: ClaudeMode = "remote";
    let activeRemote: RemoteControls | null = null;

    const rpcHandlers: SessionRpcHandlers = {
      message: async ({ envelope }) => {
        const begin = await beginSend(envelope);
        if (!begin.proceed) return begin.response;
        const queued = currentMode === "local";
        messageSignal.emit({ id: envelope.id, text: begin.text });
        return { queued, status: "queued" };
      },
      takeControl: async () => {
        takeControlSignal.emit();
        return { ok: true };
      },
      interrupt: async () => {
        if (!activeRemote) return { ok: false };
        await activeRemote.interrupt();
        return { ok: true };
      },
      setMode: async ({ mode }) => {
        if (!activeRemote) return { ok: false };
        await activeRemote.setMode(mode);
        return { ok: true };
      },
      permAnswer: async ({ reqId, decision }) => {
        if (!activeRemote) return { ok: false };
        return activeRemote.resolvePermission({ reqId, decision });
      },
      // "End session" from the web (plan-v2.md W2.3): routes through
      // `loop()`'s own double-Ctrl-C "exit the whole client" trigger
      // (`onExitRequested` below), which asks the live remote launcher to
      // exit. Same not-yet-landed status-reporting caveat as `runLocalPty`'s
      // `stop` handler — see its comment.
      stop: async ({ force }) => {
        logger.info("[start-claude] stop requested from web", { force: force ?? false });
        exitSignal.emit();
        if (force) setTimeout(() => process.exit(0), 3000).unref();
        return { ok: true };
      },
    };
    const rpcHandle = registerRpc({
      sessionId: bootstrap.sessionId,
      dek: bootstrap.dek,
      socket: sessionClient.socket,
      handlers: rpcHandlers,
      logger,
    });

    try {
      return await runLoop(
        {
          workingDirectory: deps.workingDirectory,
          startingMode: "remote",
          permissionMode,
          homeDir: deps.homeDir,
          claudeArgs: deps.claudeArgs,
          claudeEnvVars: { FALCON_CLAUDE_PATH: claudeCliPath },
          onEnvelopes: (envelopes) => outbox.enqueue(envelopes),
          onModeChange: (mode) => {
            currentMode = mode;
          },
          onRemoteActive: (controls) => {
            activeRemote = controls;
          },
          onTurnSettled: ({ messageId, status }) => {
            if (messageId) completeClaim(messageId, { status });
          },
          onMessage: (handler) => messageSignal.subscribe(handler),
          onTakeControl: (handler) => takeControlSignal.subscribe(handler),
          onExitRequested: (handler) => exitSignal.subscribe(handler),
          logger,
        },
        { local: localLauncherDeps, remote: remoteLauncherDeps },
      );
    } finally {
      rpcHandle.stop();
    }
  }

  try {
    return await (detectStartingMode(deps.claudeArgs) === "remote"
      ? runRemoteLoop()
      : runLocalPty());
  } finally {
    sessionClient.stop();
    outbox.dispose();
  }
}

/**
 * A daemon-spawned, no-terminal session is invoked as `falcon claude
 * --starting-mode remote ...` (see `daemon/spawnEngine.ts`). Everything else
 * — a human running `falcon claude` in their terminal — is the PTY-injection
 * flow. The flag reaches here verbatim (it is passthrough `providerArgs`), so
 * this is where the two flows fork.
 */
function detectStartingMode(claudeArgs: string[]): ClaudeMode {
  const index = claudeArgs.indexOf("--starting-mode");
  return index >= 0 && claudeArgs[index + 1] === "remote" ? "remote" : "local";
}
