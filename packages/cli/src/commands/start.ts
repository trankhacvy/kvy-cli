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
 * plan-v2.md Wave 1.1 — as of docs/known-issues.md issue #5, both sides of
 * that fork emit a live `perm-request` so web always sees an actionable
 * card; the fork now only decides whether the hook blocks for a web answer
 * or hands off to the terminal immediately, tracking the latter via
 * `resolveLocalOutcome` — see `onEnvelopes` below). Its `settingsEnv`/
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
 * `setMode` sends the live TUI's own Shift+Tab mode-cycle keystroke, gated
 * idle+no-prompt and verified by racing TWO independent signals — the
 * bridge's `permission_mode` hook echo AND `ptyClaudeSession.ts`'s
 * raw-PTY-output status-bar detector (`waitForModeStatus`,
 * `raceModeConfirmation` below) — plan-v2.md W4.3, extended after a
 * live-reproduced bug where an idle session (no upcoming tool call to carry
 * a hook echo) always reported a genuinely-successful switch as
 * `{ok:false}`. Flag-gated behind `FALCON_PTY_SETMODE=1`
 * (`PTY_SET_MODE_ENV_VAR` below) until live-soaked, since it's the one
 * deliberately-keystroke, version-coupled feature on this path; unset, it
 * stays the prior honest `{ok:false}` ("the live TUI owns its own permission
 * mode").
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
 *
 * Resume (plan-v2.md W3.7): both flows share one `bootstrapSession()` call,
 * which itself honors `FALCON_RECONNECT_SESSION_ID`/
 * `FALCON_RECONNECT_ENCRYPTION_KEY` (re-attaching to the existing
 * server-side session row instead of minting a fresh one — see
 * `session/bootstrap.ts`'s doc comment). The terminal PTY flow additionally
 * reads `FALCON_RECONNECT_PROVIDER_SESSION_ID` to resume the underlying
 * `claude` provider transcript itself (`--resume`, composed by
 * `resolveSessionFlags`/`ptyClaudeSession.ts`) — absent on an ordinary fresh
 * start, so both env reads are no-ops unless a caller arranged them ahead of
 * this spawn.
 *
 * Session lifecycle status (plan-v2.md W1.4+B15; PRD FR-3.7): `reportStatusOnce`
 * best-effort reports the session's terminal status to the server exactly
 * once, whichever exit path reaches it first — a clean process exit (either
 * flow's own exit code, mapped 0 ⇒ `ended` / non-zero ⇒ `failed`), or a
 * `SIGTERM`/`SIGHUP`/`SIGINT` on this wrapper process (always `ended` — a
 * signal is a normal, resumable way for a terminal session to stop). None of
 * `SIGTERM`/`SIGHUP`/`SIGINT` exit the wrapper process directly — that would
 * skip both the active flow's own cleanup (`ptySession.stop()`/
 * `rpcHandle.stop()`/`permHook.stop()`, or `runRemoteLoop`'s managed launcher
 * teardown via `loop()`'s own `onExitRequested`) and the outer
 * `sessionClient.stop()`/`outbox.dispose()` — **and, critically, the
 * per-directory session lock's `release()` (`session/sessionLock.ts`)**:
 * Node applies a signal's *default* disposition (immediate process
 * termination, no JS-level `finally` blocks run at all) to any signal with no
 * registered listener, so an unhandled `SIGINT` reaching this process at any
 * point ends it instantly and leaves the lock file behind naming a pid that's
 * now dead — exactly the stale "a Falcon session is already running" report
 * a later `falcon claude` in the same directory would otherwise have to wait
 * out (docs/known-issues.md). `SIGINT` (Ctrl-C) reaching the PTY child
 * directly — raw mode forwards the byte to the foreground process group,
 * `stdin.setRawMode(true)` in `ptyClaudeSession.ts` — only starts applying
 * once the PTY is actually up; a real, interactive-shell SIGINT still hits
 * *this* process normally during every network round trip before that (login/
 * machine-id wait/bootstrap/daemon self-report/hook install), and always
 * hits it in a non-TTY invocation (`stdin.isTTY` false — piped input,
 * headless test harnesses) where raw mode is never engaged in the first
 * place. Registering a `SIGINT` listener here doesn't fight the raw-mode
 * byte-forwarding design at all: once raw mode is active the tty driver
 * stops translating Ctrl-C into a signal in the first place (that's the
 * whole reason the byte has to be forwarded manually), so this handler
 * simply never fires during that phase — it only ever catches the gaps raw
 * mode doesn't cover. Instead of dying, each of the three signals requests a
 * graceful stop of whichever flow is live and lets that flow's own `await`
 * (and `finally` blocks) settle normally, fixing the wrapper's own final exit
 * code to 0 (SIGTERM) / 1 (SIGHUP/SIGINT) regardless of the child's own exit
 * code.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { encodeBase64, wrapDek } from "@falcon/crypto";
import { createEnvelope, type PermissionMode, type SessionEnvelope } from "@falcon/wire";
import { createId } from "@paralleldrive/cuid2";
import { createHttpClient } from "../api/httpClient.js";
import { Outbox, type OutboxOptions } from "../api/outbox.js";
import { createSessionMetadataUpdater } from "../api/sessionMetadata.js";
import {
  reportSessionAttention as reportSessionAttentionDefault,
  type SessionAttentionKind,
} from "../api/sessionNotify.js";
import {
  type ReportableSessionStatus,
  reportSessionStatus as reportSessionStatusDefault,
} from "../api/sessionStatus.js";
import { resolveBackendUrl, resolveFrontendUrl } from "../auth/config.js";
import {
  type FalconCredentials,
  readCredentials as readCredentialsDefault,
} from "../auth/credentials.js";
import { ensureLoggedIn as ensureLoggedInDefault } from "../auth/login.js";
import { displayQrCode as displayQrCodeDefault } from "../auth/qrcode.js";
import { claimMessageSend, completeMessageSend } from "../claims/claimStore.js";
import type { ClaudeLocalLauncherDeps } from "../claude/claudeLocalLauncher.js";
import type { ClaudeRemoteLauncherDeps } from "../claude/claudeRemoteLauncher.js";
import { deriveTitleFromFirstUserMessage } from "../claude/firstMessageTitle.js";
import {
  type ClaudeMode,
  type LoopDeps,
  type LoopOptions,
  loop as loopDefault,
  type QueuedMessage,
  type RemoteControls,
} from "../claude/loop.js";
import { findClaudeModelChangeInEnvelopes } from "../claude/modelChange.js";
import { permissionModeCyclePresses } from "../claude/pretoolPermissionBridge.js";
import {
  notifyTerminal,
  type PtyClaudeSessionHandle,
  startPtyClaudeSession as startPtyClaudeSessionDefault,
} from "../claude/ptyClaudeSession.js";
import {
  defaultHooksDir,
  installRemotePermissionHook as installRemotePermissionHookDefault,
  type RemotePermissionHookHandle,
} from "../claude/remotePermissionHook.js";
import {
  createNotifyDaemonSessionStartedDeps,
  notifyDaemonSessionStarted as notifyDaemonSessionStartedDefault,
  reportSessionStartFailed as reportSessionStartFailedDefault,
} from "../daemon/notify.js";
import { reloadDaemonAuth as reloadDaemonAuthDefault } from "../daemon/reloadAuth.js";
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
import { extractModelFlag } from "../session/modelFlag.js";
import { extractPermissionModeFlag } from "../session/permissionModeFlag.js";
import { registerSessionWorkspace } from "../session/registerSessionWorkspace.js";
import {
  createSessionClientDeps,
  startSessionClient as startSessionClientDefault,
} from "../session/sessionClient.js";
import {
  acquireSessionLock as acquireSessionLockDefault,
  type SessionLockHandle,
} from "../session/sessionLock.js";
import {
  KEY_REQUEST_PENDING,
  NO_TTY_CANNOT_SIGN_IN,
  NOT_A_GIT_REPOSITORY_WARNING,
  SCAN_SESSION_QR_LABEL,
  webUrlLine,
} from "../ui/messages.js";
import type { registerWorkspace as registerWorkspaceDefault } from "../workspace/registry.js";
import { runKeysApproveCommand as runKeysApproveCommandDefault } from "./keysApprove.js";
import { runPreflightWithReauth } from "./startPreflight.js";

/**
 * `setMode` on the PTY path (plan-v2.md W4.3 "Real setMode for the PTY
 * path") is version-coupled TUI behavior — a Shift+Tab keystroke cycle whose
 * exact effect depends on the pinned Claude Code build matching what this
 * bridge verified against. Kept behind this flag until the feature has been
 * live-soaked (plan-v2.md U4.5's `[human]` sub-task); unset/anything else
 * keeps the prior honest `{ok:false}` behavior.
 */
const PTY_SET_MODE_ENV_VAR = "FALCON_PTY_SETMODE";
/** Max wait for the next hook input's `permission_mode` echo before treating a mode switch as unverified. */
const PTY_SET_MODE_VERIFY_TIMEOUT_MS = 5000;

/**
 * `setModel` on the PTY path (docs/known-issues.md issue #12, "web model
 * selector") — types Claude Code's own `/model <alias>` slash command into
 * the live PTY. Same "version-coupled, keystroke-driven TUI behavior, kept
 * behind a flag until live-soaked" rationale as `PTY_SET_MODE_ENV_VAR`
 * above; unset/anything else keeps the honest `{ok:false}` behavior.
 */
const PTY_SET_MODEL_ENV_VAR = "FALCON_PTY_SETMODEL";
/**
 * Max wait for the next "Set model to ..." transcript echo
 * (`claude/modelChange.ts`) before treating a model switch as unverified.
 * Longer than `PTY_SET_MODE_VERIFY_TIMEOUT_MS` — a mode switch is confirmed
 * by the very next hook call (near-instant), but a model switch is only
 * observable once the transcript scanner's tailer picks up the new line, a
 * genuinely slower, poll/fs-driven path (`ptyClaudeSession.ts`'s tailer).
 */
const PTY_SET_MODEL_VERIFY_TIMEOUT_MS = 8000;

/** The minimal `Outbox` surface this module depends on — the real `Outbox` satisfies it structurally; a test fake can capture `enqueue` calls without a disk queue/HTTP client. */
export interface OutboxLike {
  enqueue(events: readonly SessionEnvelope[]): void;
  dispose(): void;
}

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
  /** Injectable for tests; defaults to the real `Outbox`. */
  createOutbox?: (options: OutboxOptions) => OutboxLike;
  /**
   * Injectable for tests; defaults to the real `reportSessionStatus()`
   * (`api/sessionStatus.ts`). Backs `reportStatusOnce` — the session's
   * best-effort `ended`/`failed` lifecycle report at every exit path (W1.4).
   */
  reportSessionStatus?: typeof reportSessionStatusDefault;
  /**
   * Injectable for tests; defaults to the real `reportSessionAttention()`
   * (`api/sessionNotify.ts`). Backs the best-effort `POST /v1/sessions/:id/
   * notify` fired for a pending permission/question and a completed turn
   * (docs/user-flows.md fix-plan task 4).
   */
  reportSessionAttention?: typeof reportSessionAttentionDefault;
  /**
   * Injectable for tests; defaults to the real `acquireSessionLock()`
   * (plan-v2.md W4.4 — same-directory duplicate session lock).
   */
  acquireSessionLock?: typeof acquireSessionLockDefault;
  /**
   * Injectable for tests; defaults to the real `notifyDaemonSessionStarted()`
   * (plan-v2.md W4.5 — best-effort daemon self-report; never throws).
   */
  notifyDaemonSessionStarted?: typeof notifyDaemonSessionStartedDefault;
  /**
   * Injectable for tests; defaults to the real `reportSessionStartFailed()`
   * (A4, `daemon/notify.ts` — best-effort, never throws). Fired from the
   * `bootstrapSession()` catch block below so a daemon-initiated spawn's
   * `spawnAwaiter.reject(pid, error)` can surface the REAL failure (e.g. a
   * 429 session-quota message) instead of the caller only ever learning
   * about a generic "did not report back" timeout once this process exits.
   */
  reportSessionStartFailed?: typeof reportSessionStartFailedDefault;
  /**
   * Injectable for tests; defaults to the real `registerWorkspace()`
   * (`workspace/registry.ts`). A bare terminal `falcon claude` run — unlike
   * the web "New Session" wizard's `spawn` RPC, which already registers a
   * workspace before launching — never designated its `workingDirectory` as
   * a registered workspace, so `bootstrapSession()` always recorded a `null`
   * `workspaceId` (known-issues.md #6). Best-effort: a lock-acquisition
   * failure here is logged and swallowed rather than failing the whole
   * session start, matching `notifyDaemonSessionStarted`'s precedent above.
   */
  registerWorkspace?: typeof registerWorkspaceDefault;
  frontendUrl?: string;
  /** Injectable for tests; defaults to a real `stat` of `<workingDirectory>/.git`. */
  hasGitDir?: (directory: string) => Promise<boolean>;
  /** Injectable for tests; defaults to the real terminal QR renderer (`auth/qrcode.ts`). */
  displayQrCode?: (url: string) => void;
  /**
   * Injectable for tests; defaults to the real `ensureLoggedIn()`. Injected rather
   * than called directly because `ensureLoggedIn` reads credentials through the
   * module-level reader, not `deps.readCredentials` — a test stubbing only the
   * latter would otherwise get two contradictory answers.
   */
  ensureLoggedIn?: typeof ensureLoggedInDefault;
  /** Injectable for tests; defaults to the real `reloadDaemonAuth()` (AX-1.6). */
  reloadDaemonAuth?: (homeDir: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Injectable for tests; defaults to the global `setTimeout`. Backs the
   * `setModel` RPC's transcript-echo verification wait
   * (`waitForModelEcho`, issue #12) — the one timer in this module a test
   * needs to control precisely (assert the timeout branch without actually
   * waiting `PTY_SET_MODEL_VERIFY_TIMEOUT_MS`).
   */
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Injectable for tests; defaults to the global `clearTimeout`. Pairs with `setTimeoutImpl`. */
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
  logger?: Logger;
  /**
   * Injectable for tests; defaults to the real `runKeysApproveCommand()`
   * (`commands/keysApprove.ts`). Backs the post-session review Fix 7 runs when a key
   * request arrived during this session and a human is present (`stdin.isTTY`) —
   * principle 1, never print "run X" when the exit path can run X itself.
   */
  runKeysApproveCommand?: typeof runKeysApproveCommandDefault;
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

async function hasGitDirDefault(directory: string): Promise<boolean> {
  return stat(path.join(directory, ".git")).then(
    () => true,
    () => false,
  );
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
  const createOutbox = deps.createOutbox ?? ((options: OutboxOptions) => new Outbox(options));
  const doReportSessionStatus = deps.reportSessionStatus ?? reportSessionStatusDefault;
  const doReportSessionAttention = deps.reportSessionAttention ?? reportSessionAttentionDefault;
  const doAcquireSessionLock = deps.acquireSessionLock ?? acquireSessionLockDefault;
  const doNotifyDaemonSessionStarted =
    deps.notifyDaemonSessionStarted ?? notifyDaemonSessionStartedDefault;
  const doReportSessionStartFailed =
    deps.reportSessionStartFailed ?? reportSessionStartFailedDefault;
  const setTimeoutImpl = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? ((handle) => clearTimeout(handle));
  const doRunKeysApprove = deps.runKeysApproveCommand ?? runKeysApproveCommandDefault;
  const checkHasGitDir = deps.hasGitDir ?? hasGitDirDefault;
  const doDisplayQrCode = deps.displayQrCode ?? displayQrCodeDefault;

  // W4.4: `--force-new-session` is Falcon's own flag, never Claude Code's —
  // strip it out of the passthrough args before they ever reach the real
  // `claude` CLI (same "intercept our own flags" precedent as
  // `claudeLocal.ts`'s `resolveSessionFlags`, just for a flag that isn't
  // Claude Code's to interpret at all).
  const forceNewSession = deps.claudeArgs.includes("--force-new-session");
  const claudeArgs = deps.claudeArgs.filter((arg) => arg !== "--force-new-session");

  // 9. Fail honestly, not silently, when the real `claude` CLI can't be found.
  const location = locate(env);
  if (!location) {
    writeError(`falcon claude: ${CLAUDE_NOT_INSTALLED_MESSAGE}\n`);
    return 1;
  }
  // Capture the narrowed path in a plain const — the null-guard's narrowing of
  // `location` does not carry into the nested run* closures below.
  const claudeCliPath = location.path;

  if (!(await checkHasGitDir(deps.workingDirectory))) {
    write(NOT_A_GIT_REPOSITORY_WARNING);
  }

  const backendUrl = deps.backendUrl ?? resolveBackendUrl(env);
  const frontendUrl = deps.frontendUrl ?? resolveFrontendUrl(env);

  // 1. Resolve credentials, key material, machineId and an access token as ONE
  // restartable unit (AX-1.3/AX-1.5). A dead refresh token re-pairs inline and
  // re-runs the whole thing — re-deriving `contentKeyPair` in the process, since a
  // fresh pairing can land on a different key epoch.
  const preflightResult = await runPreflightWithReauth({
    homeDir: deps.homeDir,
    backendUrl,
    readCredentials: readCreds,
    readDaemonState: readState,
    fetchImpl,
    sleep: deps.sleep ?? sleep,
    now: deps.now ?? Date.now,
    logger,
    interactive: process.stdin.isTTY === true,
    ensureLoggedIn: deps.ensureLoggedIn ?? ensureLoggedInDefault,
    reloadDaemonAuth: deps.reloadDaemonAuth ?? reloadDaemonAuthDefault,
    write,
  });
  if (!preflightResult.ok) {
    writeError(
      preflightResult.reason === "error" ? preflightResult.message : NO_TTY_CANNOT_SIGN_IN,
    );
    return 1;
  }
  const { contentKeyPair, machineId, tokenProvider, accessToken } = preflightResult.preflight;

  const sessionMetadata = {
    title: path.basename(deps.workingDirectory) || deps.workingDirectory,
    path: deps.workingDirectory,
    model: extractModelFlag(claudeArgs),
    // See `bootstrap.ts`'s `titleSource` doc comment — this session's title
    // starts out machine-set (the directory basename above), so a later
    // provider-summary auto-title (`handleSummaryTitle`, below) is still
    // allowed to replace it, right up until a human renames it.
    titleSource: "auto" as const,
  };

  // W4.4 (same-directory duplicate session lock): before minting a fresh
  // nonce (below), refuse to start a second, independent PTY session in a
  // directory a *live* Falcon session already occupies — two such processes
  // would silently fork the transcript. `--force-new-session` bypasses this
  // entirely (skips taking the lock at all, so it never contends with, or
  // steals, whatever the existing session holds). A stale lock (owner
  // process is dead — e.g. a crash the daemon's resume path is now
  // recovering from) is reclaimed transparently by `acquireSessionLock()`
  // itself; only a genuinely live holder blocks this start.
  let sessionLock: SessionLockHandle | null = null;
  if (!forceNewSession) {
    const lockResult = await doAcquireSessionLock(
      deps.homeDir,
      { machineId, workspacePath: deps.workingDirectory },
      {
        pid: process.pid,
        sessionId: null,
        startedAt: (deps.now ?? Date.now)(),
      },
    );
    if (!lockResult.ok) {
      if (lockResult.reason === "held-by-running-process") {
        const { existing } = lockResult;
        writeError(
          `falcon claude: a Falcon session is already running in this directory ` +
            `(${existing.sessionId ?? "unknown session id"}, pid ${existing.pid}), ` +
            "attach from the web, or run in another directory. Pass --force-new-session to start a second one anyway.\n",
        );
      } else {
        writeError(
          "falcon claude: could not acquire the per-directory session lock (contended), try again\n",
        );
      }
      return 1;
    }
    sessionLock = lockResult.handle;
  }

  // 3.5. Register (or resolve) this directory as a workspace — shared with
  // `startCodex.ts` via `registerSessionWorkspace()`, and the same
  // register-or-resolve `workspace/registry.ts` logic the daemon's `spawn`
  // RPC already runs before launching (`spawnEngine.ts`).
  const workspaceId = await registerSessionWorkspace(deps.workingDirectory, {
    registerWorkspace: deps.registerWorkspace,
    logger,
  });

  // 4. Bootstrap (create-or-get) the session row + its DEK.
  let bootstrap: Awaited<ReturnType<typeof bootstrapSessionDefault>>;
  try {
    bootstrap = await doBootstrapSession(
      createBootstrapSessionDeps({
        serverUrl: backendUrl,
        fetchImpl,
        getAuthToken: () => accessToken,
        logger,
      }),
      {
        machineId,
        workspacePath: deps.workingDirectory,
        workspaceId,
        nonce: createId(),
        provider: "claude-code",
        contentKeyPair,
        metadata: sessionMetadata,
        env,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[start-claude] bootstrapSession failed", { message });
    writeError(`falcon claude: failed to start session: ${message}\n`);
    // A4: best-effort self-report to the daemon (never throws, absent/
    // unreachable daemon is a silent no-op) so a daemon-initiated spawn's
    // `spawnAwaiter` can reject with THIS real message instead of only ever
    // seeing a generic timeout once this process exits.
    const reportResult = await doReportSessionStartFailed(
      createNotifyDaemonSessionStartedDeps({ homeDir: deps.homeDir, fetchImpl, logger }),
      { error: message },
    );
    logger.debug("[start-claude] daemon self-report (start failed)", { reportResult });
    if (sessionLock) await sessionLock.release();
    return 1;
  }

  // The lock file's `sessionId` was still unknown at acquire time (see the
  // doc comment on `sessionLock.ts`) — now that `bootstrapSession()` has
  // resolved, a later contender can print the real id instead of "unknown".
  if (sessionLock) await sessionLock.updateSessionId(bootstrap.sessionId);

  // W4.5: self-report to the daemon (best-effort — `notifyDaemonSessionStarted`
  // never throws, so a daemon that's absent or unreachable never blocks
  // session startup) so `falcon doctor`/`falcon kill sessions`/durability can
  // see this terminal-started session too, not just daemon-spawned ones.
  // `seq`/`metadataVersion`/`agentStateVersion` start at 0 — the server-side
  // defaults for a freshly created (or freshly reattached) row; later
  // updates to those counters are this session's own concern, not this
  // startup self-report's.
  const sessionEncryptionData = {
    encryptionKey: encodeBase64(wrapDek(bootstrap.dek, contentKeyPair.publicKey)),
    seq: 0,
    metadataVersion: 0,
    agentStateVersion: 0,
  };
  const notifyResult = await doNotifyDaemonSessionStarted(
    createNotifyDaemonSessionStartedDeps({
      homeDir: deps.homeDir,
      fetchImpl,
      logger,
    }),
    {
      sessionId: bootstrap.sessionId,
      metadata: sessionMetadata,
      encryption: sessionEncryptionData,
    },
  );
  logger.debug("[start-claude] daemon self-report", {
    sessionId: bootstrap.sessionId,
    notifyResult,
  });

  // Re-notify the daemon once the real provider session id is known (the
  // PTY flow's `onSessionId` hook, below) — the FIRST self-report above
  // fires before Claude Code has reported one, so its `metadata` never
  // carries `providerSessionId`. Without this second report the daemon's
  // local session registry never learns which transcript file this Falcon
  // session actually backs, and `transcriptIndexer.ts`'s `isManaged` lineage
  // lookup (`daemon/machineIntegration.ts`) can never recognize this
  // session's own transcript as already managed — it would otherwise get
  // re-surfaced as a duplicate "Unmanaged" card (docs/auth-ux-post-
  // verification-fixes.md, "own transcript re-flagged as unmanaged").
  // Same best-effort contract as the report above: never blocks/throws.
  function notifyDaemonProviderSessionId(providerSessionId: string): void {
    void doNotifyDaemonSessionStarted(
      createNotifyDaemonSessionStartedDeps({ homeDir: deps.homeDir, fetchImpl, logger }),
      {
        sessionId: bootstrap.sessionId,
        metadata: { ...sessionMetadata, providerSessionId },
        encryption: sessionEncryptionData,
      },
    ).then((result) => {
      logger.debug("[start-claude] daemon self-report (provider session id)", {
        sessionId: bootstrap.sessionId,
        providerSessionId,
        result,
      });
    });
  }

  write(`falcon claude: starting session ${bootstrap.sessionId}\n`);
  const sessionUrl = `${frontendUrl}/dashboard/session/${bootstrap.sessionId}/`;
  write(webUrlLine(sessionUrl));
  if (process.stdin.isTTY === true) {
    write(SCAN_SESSION_QR_LABEL);
    doDisplayQrCode(sessionUrl);
  }

  // Session lifecycle status (plan-v2.md W1.4+B15; PRD FR-3.7, design §7.5):
  // best-effort report the session's terminal status to the server exactly
  // once, from whichever exit path reaches it first (normal child exit,
  // SIGTERM/SIGHUP/SIGINT, or — in `runRemoteLoop` — the mode loop's own exit
  // code) so the web can show "Ended"/"Failed" instead of inferring nothing.
  const statusDeps = {
    backendUrl,
    accessToken: accessToken,
    fetchImpl,
    logger,
  };
  let statusReported = false;
  const reportStatusOnce = async (
    status: ReportableSessionStatus,
    error?: Error,
  ): Promise<void> => {
    if (statusReported) return;
    statusReported = true;
    await doReportSessionStatus(statusDeps, {
      sessionId: bootstrap.sessionId,
      status,
      error,
    });
  };

  // Fix-plan task 4 (docs/user-flows.md): fire-and-forget `POST /v1/sessions/
  // :id/notify` for a pending permission/question or a completed turn, so a
  // push notification actually reaches a user who's walked away — nobody
  // calls this route today. `reportSessionAttention` itself never throws
  // (typed result), so this is a plain fire-and-forget, unlike
  // `reportStatusOnce`'s once-only guard: attention fires many times over a
  // session's life, not once at exit.
  const reportAttention = (kind: SessionAttentionKind): void => {
    void doReportSessionAttention(statusDeps, {
      sessionId: bootstrap.sessionId,
      kind,
    });
  };

  // SIGTERM/SIGHUP/SIGINT can all land on this wrapper process itself (a
  // terminal closing, `kill -TERM`, or Ctrl-C) and must still end the
  // session honestly rather than leaving it looking perpetually active — and,
  // for SIGINT specifically, must be *handled at all*: once the PTY is up,
  // raw mode forwards Ctrl-C bytes to the child's foreground process group
  // instead of the tty driver generating a signal, so this handler simply
  // never fires during that phase — but before the PTY exists (every network
  // round trip above: login/machine-id wait/bootstrap/daemon self-report/
  // hook install) and in any non-TTY invocation (`stdin.isTTY` false, raw
  // mode never engaged), an unhandled SIGINT gets Node's default
  // termination — instantly, with no JS `finally` block given a chance to
  // run — which is exactly how the per-directory session lock (`session/
  // sessionLock.ts`, acquired above) was observed going stale: the wrapper
  // process is gone, but its lock file still names that now-dead pid, and
  // the next `falcon claude` in the same directory has to wait out (or
  // manually reclaim) a lock its true owner never got to release.
  //
  // Critically, this must NOT call `process.exit()` directly — that would
  // skip both the active flow's own cleanup (`runLocalPty`'s
  // `ptySession.stop()` — the actual SIGTERM to the `claude` pty child —
  // plus `rpcHandle.stop()`/`permHook.stop()`; `runRemoteLoop`'s managed
  // local/remote launcher teardown) and the outer `sessionClient.stop()`/
  // `outbox.dispose()` below (and, in turn, the outer `finally`'s
  // `sessionLock.release()`). Instead, request a graceful stop of whichever
  // flow is currently running (`requestGracefulStop`, wired by each flow)
  // and let its own `await`ed promise — and both flows' `finally` blocks —
  // settle normally; the wrapper's own exit code is fixed here (0 for
  // SIGTERM, 1 for SIGHUP/SIGINT) regardless of the child's exit code, since
  // a signal is a normal, resumable way for a terminal session to stop
  // (never "failed").
  let signalExitCode: number | null = null;
  let requestGracefulStop: (() => void) | null = null;
  // Captures the signal-triggered `reportStatusOnce()` call so the wrapper's
  // final return (below) can await it before resolving. Without this, the
  // report races the flow's own graceful stop: `reportStatusOnce`'s
  // first-wins guard (`statusReported`) makes the *later*, normally-awaited
  // call in `runLocalPty`/`runRemoteLoop`'s own exit path collapse into a
  // synchronous no-op once this handler has already flipped it, so nothing
  // in the awaited chain actually waits for this network call to land — and
  // `index.ts` calls `process.exit()` the instant this function resolves,
  // which can cut the request off mid-flight (silently dropping the very
  // "ended" report SIGTERM/SIGHUP/SIGINT handling exists to guarantee).
  let pendingStatusReport: Promise<void> | null = null;
  const onSignal = (signal: NodeJS.Signals) => {
    logger.info("[start-claude] signal — ending session", { signal });
    signalExitCode = signal === "SIGTERM" ? 0 : 1;
    pendingStatusReport = reportStatusOnce("ended");
    requestGracefulStop?.();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  process.on("SIGINT", onSignal);

  // 5. Outbox mirrors every transcript envelope to the server; disposed
  // (buffered-but-unsealed envelopes flushed to the on-disk queue, not
  // necessarily sent) once the local session ends.
  const outbox = createOutbox({
    sessionId: bootstrap.sessionId,
    dek: bootstrap.dek,
    http: createHttpClient({
      serverUrl: backendUrl,
      // issue #1 (docs/known-issues-cliweb-sync-test.md): a captured `accessToken`
      // string goes stale after ~15min and every retry hit a dead 401 forever. Pull a
      // currently-valid token from the shared `TokenProvider` on every request/retry
      // instead, and force a rotation on a 401 so the next retry isn't doomed either.
      getAuthToken: () => tokenProvider.getAccessToken(),
      onUnauthorized: () => tokenProvider.forceRefresh(),
      fetchImpl,
    }),
    homeDir: deps.homeDir,
    logger,
  });
  const sessionMetadataUpdater = createSessionMetadataUpdater({
    sessionId: bootstrap.sessionId,
    serverUrl: backendUrl,
    getAuthToken: () => tokenProvider.getAccessToken(),
    dek: bootstrap.dek,
    metadata: sessionMetadata,
    metadataVersion: 0,
    fetchImpl,
  });
  // Model-change echo watchers (issue #12, "web model selector") — mirrors
  // `PreToolPermissionBridge`'s `modeWatchers`/`waitForModeEcho`, but
  // sourced from the transcript tailer's own envelopes rather than a hook
  // field: no Claude Code hook payload carries a `permission_mode`-style
  // "current model" field, so the only signal a `/model` switch actually
  // landed is the SAME "Set model to ..." transcript line
  // `handlePossibleModelChange` already parses to persist session metadata.
  // `setModel`'s RPC handler (`runLocalPty`, below) subscribes here to
  // verify its own keystrokes actually took effect before reporting
  // success — an inherently looser signal than mode's hook-echo (free text
  // parsed from a transcript line, not a closed enum from an authoritative
  // source).
  const modelWatchers = new Set<(model: string) => void>();
  function waitForModelEcho(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const watcher = (model: string): void => {
        if (settled) return;
        settled = true;
        modelWatchers.delete(watcher);
        clearTimeoutImpl(timer);
        resolve(model);
      };
      const timer = setTimeoutImpl(() => {
        if (settled) return;
        settled = true;
        modelWatchers.delete(watcher);
        resolve(null);
      }, timeoutMs);
      modelWatchers.add(watcher);
    });
  }

  /**
   * `setMode`'s two independent confirmation signals, raced rather than
   * chained (docs/known-issues.md issue #11's sibling bug — a live-reproduced
   * "web reverted a mode switch the terminal genuinely made" report): the
   * hook-echo path ({@link RemotePermissionHookHandle.waitForModeEcho}, the
   * next `PreToolUse`/`PermissionRequest` hook call's own `permission_mode`
   * — arriving only on the session's NEXT tool call, which may be never for
   * a session switched while idle, the common case for a web-initiated mode
   * change) and the raw-PTY-output status-bar detector
   * (`ptySession.waitForModeStatus`, `ptyClaudeSession.ts`'s
   * `MODE_STATUS_PATTERNS` — fires off the very next terminal repaint, no
   * tool call required). Resolves `confirmed: true` the instant EITHER
   * signal reports the target `mode`, without waiting for the other — that's
   * the actual fix: an idle session no longer has to wait out a hook echo
   * that may never come when the terminal's own status text already proves
   * the switch landed. Only waits for BOTH to settle when neither confirms
   * the target — the honest "didn't happen" case, whose `observedMode` needs
   * the hook-echo path's answer (raw-output only ever knows "did it reach
   * the ONE mode I was told to watch for", not "what mode is it in
   * instead"). Both inputs are already bounded by the same `timeoutMs` the
   * caller passed to each, so this never waits longer than that.
   */
  function raceModeConfirmation(
    mode: PermissionMode,
    hookEcho: Promise<PermissionMode | null>,
    rawOutputConfirmed: Promise<boolean>,
  ): Promise<{ confirmed: boolean; observedMode: PermissionMode | null }> {
    return new Promise((resolve) => {
      let settled = false;
      let hookDone = false;
      let rawDone = false;
      let hookObserved: PermissionMode | null = null;

      const confirm = (observedMode: PermissionMode | null): void => {
        if (settled) return;
        settled = true;
        resolve({ confirmed: true, observedMode });
      };
      const maybeGiveUp = (): void => {
        if (settled || !hookDone || !rawDone) return;
        settled = true;
        resolve({ confirmed: false, observedMode: hookObserved });
      };

      void hookEcho.then((observed) => {
        hookDone = true;
        hookObserved = observed;
        if (observed === mode) confirm(observed);
        else maybeGiveUp();
      });
      void rawOutputConfirmed.then((matched) => {
        rawDone = true;
        if (matched) confirm(mode);
        else maybeGiveUp();
      });
    });
  }

  const handlePossibleModelChange = (envelopes: readonly SessionEnvelope[]): void => {
    const nextModel = findClaudeModelChangeInEnvelopes(envelopes);
    if (!nextModel) return;
    void sessionMetadataUpdater.updateModel(nextModel).catch((error) => {
      logger.warn("[start-claude] failed to persist live model change", {
        model: nextModel,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    for (const watcher of [...modelWatchers]) watcher(nextModel);
  };

  // Claude Code writes its own one-line transcript summary once it has one
  // (`ptyClaudeSession.ts`'s `onSummaryTitle`, sourced straight from the raw
  // scanner output — `mapClaudeToEnvelopes` never sees this entry type).
  // Proposing it as the session's title turns "manila" (every session in
  // this project, indistinguishable) into something that actually describes
  // the conversation — `updateTitle` itself is what refuses to clobber a
  // title the user set by hand.
  const handleSummaryTitle = (title: string): void => {
    void sessionMetadataUpdater.updateTitle(title).catch((error) => {
      logger.warn("[start-claude] failed to persist provider summary title", {
        title,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  // The summary line above is provider/version-dependent and in practice may
  // never arrive for a given session — the first genuine human-typed message
  // is what actually replaces the folder-name title for most sessions. Fires
  // at most once (`firstUserTitleSent`); a later summary still overwrites it
  // since both go through `updateTitle` with `titleSource: "auto"`.
  let firstUserTitleSent = false;
  const handleFirstUserMessageTitle = (envelopes: readonly SessionEnvelope[]): void => {
    if (firstUserTitleSent) return;
    const title = deriveTitleFromFirstUserMessage(envelopes);
    if (!title) return;
    firstUserTitleSent = true;
    void sessionMetadataUpdater.updateTitle(title).catch((error) => {
      logger.warn("[start-claude] failed to persist first-message title", {
        title,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  // Fix 7 (auth-ux-overhaul-fix-plan.md): a key request raised on another device while
  // this session runs must reach the person at THIS terminal, not just a log file nobody
  // tails. `undefined` means "none seen"; once set, the exit path below runs the review.
  let pendingKeyRequestLabel: string | null | undefined;

  // The session-scoped `/v1/stream` connection `message`/`interrupt`/
  // `takeControl`/`setMode`/`perm.answer` arrive over (design §4.4). Without
  // this, nothing on the CLI side ever joins the `s:<sessionId>:<method>`
  // room the server's RPC relay looks up.
  const sessionClient = startSessionClient(
    createSessionClientDeps(
      {
        serverUrl: backendUrl,
        tokenProvider,
        sessionId: bootstrap.sessionId,
      },
      {
        logger,
        onKeyRequest: ({ label }) => {
          pendingKeyRequestLabel = label;
          // Best-effort, live half of the notification — a terminal without OSC 9
          // support just ignores this. The guarantee is the exit-path review below.
          if (process.stdout.isTTY) {
            notifyTerminal(write, "Falcon: a device is asking for your keys");
          }
        },
      },
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
      return {
        proceed: false,
        response: { queued: false, status: "duplicate" },
      };
    }
    if (claim.status === "in-progress") {
      logger.warn("[start-claude] message RPC outcome indeterminate — open claim, not re-running", {
        id: envelope.id,
      });
      return {
        proceed: false,
        response: { queued: false, status: "outcome-unknown" },
      };
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

    // `call` -> tool name, learned from each `tool-start` envelope and
    // consumed by its matching `tool-end` (docs/known-issues.md issue #5):
    // the tailer's tool-end carries no tool name of its own, but
    // `permHook.resolveLocalOutcome` needs one to correlate back to a
    // locally-pending permission/question request. Unbounded but
    // self-limiting in practice — every `tool-start` is followed by exactly
    // one `tool-end` for the same `call`, so an entry is removed the instant
    // it's read.
    const toolNameByCall = new Map<string, string>();

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
          notifyDaemonProviderSessionId(id);
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
          if (kind === "done") {
            ptyHandle?.setPromptOpen(false);
            // Fix-plan task 1 (docs/user-flows.md): the `Stop` hook is
            // Claude Code's own authoritative "the turn just finished"
            // signal — close the turn on the wire the instant it fires
            // instead of waiting for the transcript scanner to retroactively
            // close it on the NEXT prompt (`envelopeMapper.ts`'s `closeTurn`,
            // only ever called from the `type:"user"` branch).
            void ptyHandle?.closeTurn("completed");
            reportAttention("done");
          }
        },
        // The bridge's local-turn path (a dialog may be about to render at
        // the terminal) — the earlier, less certain half of the same gate.
        onPromptLikely: () => ptyHandle?.setPromptOpen(true),
        // Fix-plan task 4 (docs/user-flows.md): fires for BOTH web- and
        // locally-initiated turns (unlike the `perm-request` envelope this
        // bridge emits, which stays local-turn-honest) — a push notification
        // is a harmless side-signal, and the server's own presence
        // suppression already avoids over-notifying an actively-watching tab.
        onPendingAttention: (kind) => reportAttention(kind),
        // Real two-way remote control (the point of `falcon claude`): a web
        // decision on a locally-typed turn's permission dialog actually
        // drives the live PTY, not just a read-only mirror. `ptyHandle` is
        // assigned once `runPtySession` returns below — safe to reference
        // here since this closure only ever fires after that (same
        // forward-ref pattern `onPromptLikely`/`onSessionId` already use).
        driveLocalDialog: (decision, toolName) =>
          ptyHandle?.answerPermission(
            decision,
            permHook?.getCurrentPermissionMode() ?? null,
            toolName,
          ) ?? false,
        driveLocalQuestion: (decision, questions) =>
          ptyHandle?.answerAskUserQuestion(decision, questions) ?? false,
        // The mode this local PTY session actually launched in
        // (docs/bug-fix-plan.md issue #5) — a `--permission-mode` passthrough
        // flag if the user gave one, else Claude Code's own "default". Seeds
        // the bridge's mode cache so a Shift+Tab before the first tool call
        // is a real, emittable transition instead of an unfalsifiable "first
        // observation".
        initialPermissionMode: extractPermissionModeFlag(claudeArgs) ?? "default",
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
        claudeArgs,
        // Resumes the provider transcript on the terminal PTY flow
        // (`resolveSessionFlags`/`ptyClaudeSession.ts` already handle
        // `--resume` composition from this) — set only when a caller
        // arranged the reconnect env ahead of this spawn (plan-v2.md W3.7);
        // ordinarily absent, i.e. a fresh provider session.
        providerSessionId: env.FALCON_RECONNECT_PROVIDER_SESSION_ID?.trim() || null,
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
          // The same tool-start/tool-end pair is also the "resolved locally"
          // signal for a permission-gated tool call (docs/known-issues.md
          // issue #5): Claude Code records a `tool_result` for a call either
          // way, allowed or denied, so `tool-end`'s own `ok` flag is the real
          // outcome — correlate it back through `toolNameByCall` (tool-end
          // itself carries no name) and complete the matching local pending
          // request, if any (a no-op when there isn't one — e.g. an
          // auto-allowed tool that never hit a permission hook at all).
          for (const envelope of envelopes) {
            if (envelope.ev.t === "tool-start") {
              toolNameByCall.set(envelope.ev.call, envelope.ev.name);
            } else if (envelope.ev.t === "tool-end") {
              const toolName = toolNameByCall.get(envelope.ev.call);
              toolNameByCall.delete(envelope.ev.call);
              if (toolName) {
                permHook?.resolveLocalOutcome(toolName, envelope.ev.ok ? "approved" : "denied");
              }
            }
          }
          handlePossibleModelChange(envelopes);
          handleFirstUserMessageTitle(envelopes);
          outbox.enqueue(envelopes);
        },
        onSummaryTitle: handleSummaryTitle,
        // The send-claim completes the moment the message is actually typed +
        // submitted into the PTY — from there a retry is an honest duplicate.
        // That same submit is the "a web turn just began" signal: mark it so
        // this turn's `PreToolUse` prompts route to the web PermCard.
        onInjected: (id) => {
          completeClaim(id, { status: "injected" });
          permHook?.markWebTurnStart();
        },
        // No silent message loss (plan-v2.md W3.9): a message that will now
        // never be injected (session ending with it still queued, or its
        // submit skipped because the child exited mid-injection) still had a
        // send-claim opened for it — complete it as a terminal, honest
        // result instead of leaving it open. A later retry of the same
        // envelope id then sees `duplicate` (claim already completed) rather
        // than `outcome-unknown` for a message that never actually ran.
        onDroppedInjections: (messages) => {
          for (const m of messages) completeClaim(m.id, { status: "dropped-session-ended" });
        },
        // A locally-typed Enter at the real keyboard is the human reclaiming
        // the turn — clear the web-turn flag immediately (plan-v2.md W1.2).
        onLocalSubmit: () => permHook?.markLocalActivity(),
        logger,
      },
      { logger },
    );
    ptyHandle = ptySession;
    // A SIGTERM/SIGHUP/SIGINT on the wrapper stops this PTY child the same
    // way any other stop does — SIGTERM to the child, `ptySession.done`
    // resolving once it actually exits — so this flow's normal completion
    // path (below) runs, rather than the wrapper exiting out from under it.
    requestGracefulStop = () => ptySession.stop();

    // A lifecycle moment the web timeline should see even though nothing in
    // the Claude Code transcript itself says it (plan-v2.md W3.3) — the PTY
    // is spawned (or, if `runPtySession`'s own setup failed, about to report
    // that below via a non-zero `done` exit code; `ptyClaudeSession.ts`'s
    // `done` never rejects, so a spawn failure is only observable that way).
    outbox.enqueue([createEnvelope("agent", { t: "service", text: "session started" })]);

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
      // Real PTY setMode (plan-v2.md W4.3), flag-gated behind
      // `FALCON_PTY_SETMODE=1` (see the module-level doc comment on
      // `PTY_SET_MODE_ENV_VAR`). Computes the forward Shift+Tab press count
      // from the bridge's cached `permission_mode` (the live TUI's own,
      // authoritative state — there is no other channel to ask it) to the
      // requested mode, sends it gated idle+no-prompt via
      // `ptySession.sendModeCycle` (the same rule message injection uses),
      // then races TWO independent confirmation signals
      // (`raceModeConfirmation`, above — the hook's own `permission_mode`
      // echo AND the terminal's own raw-output status-bar text) before
      // reporting success, so a session sitting idle (no upcoming tool call
      // to carry a hook echo) doesn't falsely report `{ok:false}` when the
      // keystrokes actually landed — a live-reproduced bug where the web UI
      // reverted a mode switch the terminal had genuinely made. Every
      // early-out is an honest `{ok:false}` (optionally carrying the best
      // `observedMode` available) rather than a faked success — same "never
      // fake it" rule the old always-`false` handler followed.
      setMode: async ({ mode }) => {
        if (env[PTY_SET_MODE_ENV_VAR] !== "1") return { ok: false };

        const current = permHook?.getCurrentPermissionMode() ?? null;
        if (current === null) {
          logger.debug(
            "[start-claude] setMode: no permission_mode observed from a hook yet — can't compute a cycle",
          );
          return { ok: false };
        }
        if (current === mode) return { ok: true, observedMode: current };

        const presses = permissionModeCyclePresses(current, mode);
        if (!ptySession.sendModeCycle(presses)) {
          logger.debug("[start-claude] setMode: injection gate closed — not sending keystrokes", {
            current,
            requested: mode,
            presses,
          });
          return { ok: false, observedMode: current };
        }

        const { confirmed, observedMode } = await raceModeConfirmation(
          mode,
          permHook?.waitForModeEcho(PTY_SET_MODE_VERIFY_TIMEOUT_MS) ?? Promise.resolve(null),
          ptySession.waitForModeStatus(mode, PTY_SET_MODE_VERIFY_TIMEOUT_MS),
        );
        if (confirmed) {
          // Keep the bridge's own cache in sync even when confirmation came
          // ONLY from the raw-output signal (no hook call occurred) — without
          // this, `current` above would stay stale on the NEXT `setMode`
          // call, computing that call's press count from the wrong starting
          // mode (live-reproduced: Default→Plan confirmed via raw output
          // alone, then Plan→AcceptEdits right after computed its presses
          // from a still-cached "default" and landed back on "default").
          permHook?.notePermissionMode(observedMode ?? mode);
          return { ok: true, observedMode: observedMode ?? mode };
        }

        logger.warn(
          "[start-claude] setMode: neither the hook echo nor the terminal's own status text confirmed the switch",
          { requested: mode, observed: observedMode },
        );
        return { ok: false, observedMode: observedMode ?? current };
      },
      // Real PTY setModel (docs/known-issues.md issue #12), flag-gated
      // behind `FALCON_PTY_SETMODEL=1` — see `PTY_SET_MODEL_ENV_VAR`'s doc
      // comment. Types `/model <alias>` into the live PTY via
      // `ptySession.sendModelChange` (same idle/no-prompt gate message
      // injection uses), then verifies via the transcript's own "Set model
      // to ..." echo (`waitForModelEcho`) before reporting success — there
      // is no hook field to ask instead, unlike `setMode`'s
      // `permission_mode` echo. Every early-out is an honest `{ok:false}`,
      // never a faked success, same "never fake it" rule `setMode` follows.
      setModel: async ({ model }) => {
        if (env[PTY_SET_MODEL_ENV_VAR] !== "1") return { ok: false };

        if (!ptySession.sendModelChange(model)) {
          logger.debug("[start-claude] setModel: injection gate closed — not sending /model", {
            requested: model,
          });
          return { ok: false };
        }

        const observed = await waitForModelEcho(PTY_SET_MODEL_VERIFY_TIMEOUT_MS);
        if (observed) return { ok: true, observedModel: observed };

        logger.warn("[start-claude] setModel: transcript echo did not confirm the switch", {
          requested: model,
        });
        return { ok: false };
      },
      // Remote answering of the live TUI's tool-permission prompt (design
      // §7.6): route into the `PreToolUse` hook bridge (first-wins). Only when
      // the hook server failed to install is this honestly not-supported.
      permAnswer: async ({ reqId, decision }) => {
        if (permHook) return permHook.resolvePermission({ reqId, decision });
        logger.debug("[start-claude] perm.answer RPC — no live permission hook to route to");
        return { ok: false };
      },
      // "End session" from the web (plan-v2.md W2.3): report "ended" FIRST
      // (landing before the WS drops, so a stop that races the disconnect
      // still surfaces — U1.4's additive `"ended"` transition makes this
      // honest), then SIGTERM the PTY child. `force` doesn't SIGKILL the
      // child directly — `ptyProcess.kill()` has no signal override yet — it
      // instead exits this whole CLI process after a short grace period so a
      // hung child can't block the "web says stopped" outcome the user asked
      // for.
      stop: async ({ force }) => {
        logger.info("[start-claude] stop requested from web", {
          force: force ?? false,
        });
        await reportStatusOnce("ended");
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

    let exitCode: number;
    try {
      exitCode = await ptySession.done;
    } finally {
      ptySession.stop();
      rpcHandle.stop();
      if (permHook) await permHook.stop();
    }
    // A clean exit (0) is a normal/resumable end; anything else is the PTY
    // child crashing or exiting abnormally — report accordingly (W1.4). A
    // non-zero code covers both a normal non-zero `claude` exit AND
    // `ptyClaudeSession.ts`'s own internal setup/spawn-failure path (its
    // `run()` catch resolves `done(1)` — there is no separate signal for
    // "spawn failed" vs "the child genuinely exited 1").
    await reportStatusOnce(
      exitCode === 0 ? "ended" : "failed",
      exitCode === 0 ? undefined : new Error(`claude exited with code ${exitCode}`),
    );
    outbox.enqueue([
      createEnvelope("agent", {
        t: "service",
        text:
          exitCode === 0 ? "session ended" : `session ended unexpectedly (exit code ${exitCode})`,
      }),
    ]);
    return exitCode;
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
    const localLauncherDeps: ClaudeLocalLauncherDeps = {
      launcherPath: deps.launcherPath,
      logger,
    };
    // Defaults-only, but a real object — a mid-run switch calls
    // `startClaudeRemoteLauncher(..., deps.remote)`.
    const remoteLauncherDeps: ClaudeRemoteLauncherDeps = {};
    const permissionMode: PermissionMode = "default";

    const messageSignal = createSignal<QueuedMessage>();
    const takeControlSignal = createSignal<void>();
    // `loop()`'s own double-Ctrl-C "exit the whole client" trigger — reused
    // here as the SIGTERM/SIGHUP/SIGINT graceful-stop path so a signal on
    // this wrapper causes `activeRemote.requestExit()` (loop.ts) rather than
    // the wrapper exiting out from under the managed launcher process.
    const exitSignal = createSignal<void>();
    requestGracefulStop = () => exitSignal.emit();
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
      // Not supported on the headless ACP remote-loop flow (issue #12 scopes
      // the web model selector to the terminal-attached PTY path only — no
      // live TUI to type `/model` into here, and ACP has no analogous
      // model-change call). Honest `{ok:false}`, same as this flow's own
      // `setMode` when `activeRemote` isn't up yet.
      setModel: async () => ({ ok: false }),
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
        logger.info("[start-claude] stop requested from web", {
          force: force ?? false,
        });
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
      const code = await runLoop(
        {
          workingDirectory: deps.workingDirectory,
          startingMode: "remote",
          permissionMode,
          homeDir: deps.homeDir,
          claudeArgs,
          claudeEnvVars: { FALCON_CLAUDE_PATH: claudeCliPath },
          onEnvelopes: (envelopes) => {
            handlePossibleModelChange(envelopes);
            outbox.enqueue(envelopes);
          },
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
      // Same exit-code -> status mapping as the PTY flow's `runLocalPty`
      // (W1.4): a clean loop exit is a normal/resumable end.
      await reportStatusOnce(
        code === 0 ? "ended" : "failed",
        code === 0 ? undefined : new Error(`claude exited with code ${code}`),
      );
      return code;
    } finally {
      rpcHandle.stop();
    }
  }

  try {
    const code = await (detectStartingMode(claudeArgs) === "remote"
      ? runRemoteLoop()
      : runLocalPty());
    // A signal's exit code (0 for SIGTERM, 1 for SIGHUP/SIGINT) always wins
    // over whatever exit code the underlying child/loop happened to settle
    // with — being asked to stop is a normal, resumable end, not a crash.
    return signalExitCode ?? code;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    process.off("SIGINT", onSignal);
    // Let a still-in-flight signal-triggered status report actually land
    // (or hit its own timeout) before this function resolves — see
    // `pendingStatusReport`'s doc comment above for why this can't just
    // rely on the normal-exit path's own `await reportStatusOnce(...)`.
    if (pendingStatusReport) await pendingStatusReport;

    // Fix 7: the durable half of the key-request notification, and — when a human is
    // actually here to answer it — the review itself, run inline rather than telling the
    // user to go run `falcon keys approve` (principle 1). Safe to open a `readline` on
    // stdin here: both flows above have already restored raw mode as part of their own
    // teardown by the time their awaited promise resolves.
    if (pendingKeyRequestLabel !== undefined) {
      write(KEY_REQUEST_PENDING);
      if (process.stdin.isTTY) {
        await doRunKeysApprove({
          homeDir: deps.homeDir,
          backendUrl,
          fetchImpl,
          logger,
          write,
          writeError,
        });
      }
    }

    sessionClient.stop();
    outbox.dispose();
    if (sessionLock) await sessionLock.release();
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
