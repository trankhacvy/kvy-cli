/**
 * Composition that wires remote permission answering into a live Claude Code
 * TUI session (design §7.4/§7.6, plan.md §17). It ties together the three
 * pieces that already exist in isolation:
 *
 *  - {@link PreToolPermissionBridge} — the decision-routing core. `PreToolUse`
 *    defers (`ask`) for every tool except `AskUserQuestion`, which it
 *    intercepts directly (deny-with-answer, plan-v2.md Wave 2.1);
 *    `PermissionRequest` is where the web-vs-terminal fork for everything
 *    else lives (local-vs-web policy, perm-request/perm-resolve emission,
 *    first-wins `perm.answer`, timeout→deny fallback) — design §7.6,
 *    plan-v2.md Wave 1.1.
 *  - {@link startHookServer} — the loopback server, with `onPreToolUse` and
 *    `onPermissionRequest` endpoints the generated hook forwarder POSTs to
 *    and blocks on for the decision.
 *  - {@link writeHookSettingsFile} — the temp `--settings` file, carrying
 *    `PreToolUse` and `PermissionRequest` hooks alongside the existing
 *    `SessionStart`/`Notification`/`Stop` ones.
 *
 * ## What the caller (`commands/start.ts`) wires from the returned handle
 *  - `settingsEnv` — merge into the spawned `claude`'s `claudeEnvVars` so
 *    whatever launches the live TUI passes `--settings "$FALCON_HOOK_SETTINGS_PATH"`.
 *    (Falcon's local spawn wrapper already supports a `--settings` hook file;
 *    the exact `--settings` plumbing for the PTY-wrapped TUI is the input
 *    path's job and is reconciled at merge — this env var is how the path
 *    reaches it without this module reaching into the spawn.)
 *  - `resolvePermission` — the `perm.answer` session RPC's handler for the
 *    live TUI (the ACP remote handler is unrelated; this is the TUI path).
 *  - `resolveLocalOutcome` — wired from the PTY tailer's `tool-start`/
 *    `tool-end` envelopes (docs/known-issues.md issue #5): a locally-typed
 *    turn's permission prompt is now visible on web too, but its hook already
 *    hands off to the terminal immediately, so this is the only channel that
 *    tells the bridge (and, via a `perm-resolve` envelope, web) what actually
 *    happened once the terminal human answers.
 *  - `markWebTurnStart` / `markTurnEnd` — the turn-origin signal the bridge's
 *    local-vs-web policy reads. `markWebTurnStart()` on a web-injected
 *    `message`; `markTurnEnd()` when the turn finishes (also fired
 *    automatically from Claude Code's own `Stop` hook here) or control
 *    returns to the terminal. The flag is self-healing rather than a plain
 *    boolean (plan-v2.md W1.2): `markLocalActivity()` — wired to a locally-
 *    typed Enter at the real keyboard — clears it immediately (a present
 *    human beats a remote one), and a `WEB_TURN_MAX_MS` watchdog auto-clears
 *    a web turn that's gone quiet too long (a missed `Stop` hook, e.g. a
 *    crash, must not wedge every future prompt onto the web forever).
 *  - `stop` — tear everything down in the session's `finally`.
 *
 * The server is a single owner of all four hooks, so if the surrounding
 * session process also needs `SessionStart`/`Notification`/`Stop` (session-id
 * discovery, attention), it forwards them through `onSessionId`/`onAttention`
 * rather than starting a second server.
 */

import path from "node:path";
import type { PermDecision, PermissionMode, SessionEnvelope } from "@falcon/wire";
import type { PermAnswerResult } from "../acp/acpPermissionHandler.js";
import type { Logger } from "../logger.js";
import {
  type AttentionKind,
  type HookServerHandle,
  startHookServer as startHookServerDefault,
  writeHookSettingsFile as writeHookSettingsFileDefault,
} from "./hookServer.js";
import type { AskQuestion } from "./pretoolPermissionBridge.js";
import { PreToolPermissionBridge } from "./pretoolPermissionBridge.js";

/** Env var carrying the generated `--settings` path onto the spawned `claude`'s environment. */
export const HOOK_SETTINGS_ENV_VAR = "FALCON_HOOK_SETTINGS_PATH";

/**
 * Default max quiet time before an active web turn auto-clears (plan-v2.md
 * W1.2's watchdog). Refreshed by hook traffic while the flag is set, so this
 * only fires on a genuinely wedged turn (e.g. a missed `Stop` hook after a
 * crash), never on a merely-long-running one.
 */
export const WEB_TURN_MAX_MS = 30 * 60 * 1000;

export interface RemotePermissionHookOptions {
  /** Directory to write the temp `--settings` + forwarder into (e.g. `<homeDir>/tmp/hooks`). */
  hooksDir: string;
  /** Emits perm-request/perm-resolve envelopes onto the session timeline (→ the outbox). */
  emitEnvelope: (envelope: SessionEnvelope) => void;
  /** Best-effort live-TUI mode sync for a `{kind:'mode'}` decision (default no-op). */
  onModeChange?: (mode: PermissionMode) => void;
  /** Forwarded straight to {@link PreToolPermissionBridge}'s own
   * `initialPermissionMode` — the mode the caller knows the session actually
   * launched in (docs/bug-fix-plan.md issue #5), e.g. `start.ts`'s
   * `extractPermissionModeFlag(claudeArgs) ?? "default"`. */
  initialPermissionMode?: PermissionMode;
  /** Forwarded from Claude Code's `SessionStart` hook (the real provider session UUID). */
  onSessionId?: (sessionId: string) => void;
  /** Forwarded from Claude Code's `Notification`/`Stop` attention hooks. */
  onAttention?: (kind: AttentionKind) => void;
  /**
   * Fires when the bridge sees a hook decision that means a TUI dialog is (or
   * is about to be) on screen at the terminal — a local-turn `PreToolUse`
   * `ask` or a local-turn `PermissionRequest` deferral (plan-v2.md W1.3). The
   * caller wires this to the PTY session's `setPromptOpen(true)` so a queued
   * web message never gets typed into an open dialog.
   */
  onPromptLikely?: () => void;
  /**
   * Fires the instant a permission request or `AskUserQuestion` becomes
   * pending, regardless of local vs. web (docs/user-flows.md fix-plan task
   * 4) — forwarded straight from {@link PreToolPermissionBridge}'s own
   * `onPendingAttention` dep. The caller (`start.ts`) wires this to a
   * `POST /v1/sessions/:id/notify` call so a push notification fires for a
   * pending permission/question even when the turn originated locally.
   */
  onPendingAttention?: (kind: "perm" | "question") => void;
  /** Forwarded straight to {@link PreToolPermissionBridge}'s own
   * `driveLocalDialog` — real keystroke-injection into the live PTY for a
   * web decision on a locally-typed turn's ordinary permission prompt. */
  driveLocalDialog?: (decision: PermDecision, toolName: string) => boolean;
  /** Forwarded straight to {@link PreToolPermissionBridge}'s own
   * `driveLocalQuestion` — same idea, for a locally-typed turn's
   * `AskUserQuestion` widget. */
  driveLocalQuestion?: (decision: PermDecision, questions: AskQuestion[]) => boolean;
  /** Max wait for a web answer before the bridge falls back to a deny. */
  answerTimeoutMs?: number;
  /**
   * Any web turn quiet longer than this auto-clears the web-turn flag — a
   * missed `Stop` hook (e.g. a crash) must not wedge every future prompt onto
   * the web forever (plan-v2.md W1.2). Default 30 minutes.
   */
  webTurnMaxMs?: number;
  logger?: Logger;
}

export interface RemotePermissionHookDeps {
  /** Injectable for tests; defaults to the real loopback hook server. */
  startHookServer?: typeof startHookServerDefault;
  /** Injectable for tests; defaults to the real settings-file writer. */
  writeHookSettingsFile?: typeof writeHookSettingsFileDefault;
  /** Injectable for tests; defaults to the global `Date.now`. */
  now?: () => number;
}

export interface RemotePermissionHookHandle {
  /** Absolute path to the generated `--settings` file to pass to `claude`. */
  settingsPath: string;
  /** `{ FALCON_HOOK_SETTINGS_PATH: <settingsPath> }` — merge into `claudeEnvVars`. */
  settingsEnv: Record<string, string>;
  /** Loopback port the hook forwarder talks to (introspection/tests). */
  port: number;
  /** Wire into the `perm.answer` session RPC (first-wins resolution). */
  resolvePermission: (params: { reqId: string; decision: PermDecision }) => PermAnswerResult;
  /**
   * Correlates a locally-resolved permission/question's outcome back to its
   * pending request (docs/known-issues.md issue #5 — "web card must not hang
   * forever"). Wire into the PTY tailer's own `tool-start`→`tool-end`
   * tracking in `start.ts`'s `onEnvelopes`: forwards to {@link
   * PreToolPermissionBridge.resolveLocalOutcome}.
   */
  resolveLocalOutcome: (toolName: string, outcome: "approved" | "denied") => void;
  /**
   * The last `permission_mode` seen on any hook input, or `null` before the
   * first one fires. The PTY `setMode` RPC's only source of truth for the
   * live TUI's actual mode (plan-v2.md W4.3) — forwards {@link
   * PreToolPermissionBridge.currentPermissionMode}.
   */
  getCurrentPermissionMode: () => PermissionMode | null;
  /**
   * Resolves with the `permission_mode` observed on the NEXT hook input, or
   * `null` on `timeoutMs` with none seen — the "verify via hook echo" half
   * of the real PTY `setMode` (plan-v2.md W4.3). Forwards {@link
   * PreToolPermissionBridge.waitForModeEcho}.
   */
  waitForModeEcho: (timeoutMs: number) => Promise<PermissionMode | null>;
  /**
   * True once `markWebTurnStart()` has fired and `markTurnEnd()`/
   * `markLocalActivity()` has not, AND the turn hasn't gone quiet past
   * `webTurnMaxMs` (the watchdog — plan-v2.md W1.2). Calling this refreshes
   * the watchdog's last-activity clock, since hook traffic while the flag is
   * set counts as evidence the turn is still genuinely alive.
   */
  isWebTurnActive: () => boolean;
  /** Call when a web-injected message starts a turn — routes this turn's tool prompts to the web. */
  markWebTurnStart: () => void;
  /** Call when the turn ends / control returns local — stops routing to the web. */
  markTurnEnd: () => void;
  /**
   * Call when the human at the real terminal submits input (a locally-typed
   * Enter outside injection) — clears the web-turn flag immediately. A
   * present human beats a remote one (plan-v2.md W1.2's known, accepted
   * residual: this also flips a still-genuinely-running web turn's
   * subsequent prompts to the terminal).
   */
  markLocalActivity: () => void;
  /** Tear down: stop the server, remove the temp files, deny any dangling requests. */
  stop: () => Promise<void>;
}

/**
 * Start the hook server, write the `--settings` file, and return the wiring
 * handle. Awaits the server's listen so `settingsEnv`/`port` are ready to use.
 */
export async function installRemotePermissionHook(
  opts: RemotePermissionHookOptions,
  deps: RemotePermissionHookDeps = {},
): Promise<RemotePermissionHookHandle> {
  const startServer = deps.startHookServer ?? startHookServerDefault;
  const writeSettings = deps.writeHookSettingsFile ?? writeHookSettingsFileDefault;
  const now = deps.now ?? (() => Date.now());
  const webTurnMaxMs = opts.webTurnMaxMs ?? WEB_TURN_MAX_MS;

  // Epochs + a watchdog instead of a plain boolean (plan-v2.md W1.2): a
  // missed `Stop` hook (crash) must not wedge every future prompt onto the
  // web forever, and a locally-typed submit must be able to reclaim the
  // turn immediately (see `markLocalActivity`'s own doc).
  let webTurnStartedAt: number | null = null;
  let webTurnLastActivityAt = 0;
  const isWebTurnActive = (): boolean => {
    if (webTurnStartedAt === null) return false;
    if (now() - webTurnLastActivityAt > webTurnMaxMs) {
      opts.logger?.warn("[remote-perm-hook] web-turn flag expired via watchdog");
      webTurnStartedAt = null;
      return false;
    }
    webTurnLastActivityAt = now(); // hook traffic while active keeps it alive
    return true;
  };
  const markWebTurnStart = () => {
    webTurnStartedAt = now();
    webTurnLastActivityAt = webTurnStartedAt;
    opts.logger?.debug("[remote-perm-hook] web turn started");
  };
  const markTurnEnd = () => {
    webTurnStartedAt = null;
    opts.logger?.debug("[remote-perm-hook] turn ended");
  };
  const markLocalActivity = () => {
    webTurnStartedAt = null;
    opts.logger?.debug("[remote-perm-hook] local activity observed — clearing web-turn flag");
  };

  const bridge = new PreToolPermissionBridge({
    emitEnvelope: opts.emitEnvelope,
    isWebTurnActive,
    onModeChange: opts.onModeChange,
    onPromptLikely: opts.onPromptLikely,
    onPendingAttention: opts.onPendingAttention,
    driveLocalDialog: opts.driveLocalDialog,
    driveLocalQuestion: opts.driveLocalQuestion,
    answerTimeoutMs: opts.answerTimeoutMs,
    initialPermissionMode: opts.initialPermissionMode,
    logger: opts.logger,
  });

  let server: HookServerHandle;
  try {
    server = await startServer({
      onSessionId: opts.onSessionId ?? (() => {}),
      onAttention: (kind) => {
        // Claude Code's own `Stop` hook is the authoritative turn-end signal.
        if (kind === "done") markTurnEnd();
        opts.onAttention?.(kind);
      },
      onPreToolUse: (input) => bridge.handlePreToolUse(input),
      onPermissionRequest: (input) => bridge.handlePermissionRequest(input),
      logger: opts.logger,
    });
  } catch (error) {
    opts.logger?.error("[remote-perm-hook] failed to start hook server", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const settings = writeSettings(opts.hooksDir, server.port);
  opts.logger?.debug("[remote-perm-hook] installed", {
    port: server.port,
    settingsPath: settings.path,
  });

  return {
    settingsPath: settings.path,
    settingsEnv: { [HOOK_SETTINGS_ENV_VAR]: settings.path },
    port: server.port,
    resolvePermission: (params) => bridge.resolve(params),
    resolveLocalOutcome: (toolName, outcome) => bridge.resolveLocalOutcome(toolName, outcome),
    getCurrentPermissionMode: () => bridge.currentPermissionMode,
    waitForModeEcho: (timeoutMs) => bridge.waitForModeEcho(timeoutMs),
    isWebTurnActive,
    markWebTurnStart,
    markTurnEnd,
    markLocalActivity,
    stop: async () => {
      bridge.reset();
      settings.cleanup();
      await server.stop();
      opts.logger?.debug("[remote-perm-hook] stopped");
    },
  };
}

/** Convenience: the conventional hooks temp directory under a Falcon home dir. */
export function defaultHooksDir(homeDir: string): string {
  return path.join(homeDir, "tmp", "hooks");
}
