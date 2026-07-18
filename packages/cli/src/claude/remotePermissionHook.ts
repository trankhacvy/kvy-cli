/**
 * Composition that wires remote permission answering into a live Claude Code
 * TUI session (design §7.4/§7.6, plan.md §17). It ties together the three
 * pieces that already exist in isolation:
 *
 *  - {@link PreToolPermissionBridge} — the decision-routing core (local-vs-web
 *    policy, perm-request/perm-resolve emission, first-wins `perm.answer`,
 *    timeout→deny fallback).
 *  - {@link startHookServer} — the loopback server, now with an
 *    `onPreToolUse` endpoint the generated hook forwarder POSTs to and blocks
 *    on for the decision.
 *  - {@link writeHookSettingsFile} — the temp `--settings` file, now carrying
 *    a `PreToolUse` hook alongside the existing `SessionStart`/`Notification`/
 *    `Stop` ones.
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
 *  - `markWebTurnStart` / `markTurnEnd` — the turn-origin signal the bridge's
 *    local-vs-web policy reads. `markWebTurnStart()` on a web-injected
 *    `message`; `markTurnEnd()` when the turn finishes (also fired
 *    automatically from Claude Code's own `Stop` hook here) or control
 *    returns to the terminal.
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
import { PreToolPermissionBridge } from "./pretoolPermissionBridge.js";

/** Env var carrying the generated `--settings` path onto the spawned `claude`'s environment. */
export const HOOK_SETTINGS_ENV_VAR = "FALCON_HOOK_SETTINGS_PATH";

export interface RemotePermissionHookOptions {
  /** Directory to write the temp `--settings` + forwarder into (e.g. `<homeDir>/tmp/hooks`). */
  hooksDir: string;
  /** Emits perm-request/perm-resolve envelopes onto the session timeline (→ the outbox). */
  emitEnvelope: (envelope: SessionEnvelope) => void;
  /** Best-effort live-TUI mode sync for a `{kind:'mode'}` decision (default no-op). */
  onModeChange?: (mode: PermissionMode) => void;
  /** Forwarded from Claude Code's `SessionStart` hook (the real provider session UUID). */
  onSessionId?: (sessionId: string) => void;
  /** Forwarded from Claude Code's `Notification`/`Stop` attention hooks. */
  onAttention?: (kind: AttentionKind) => void;
  /** Max wait for a web answer before the bridge falls back to a deny. */
  answerTimeoutMs?: number;
  logger?: Logger;
}

export interface RemotePermissionHookDeps {
  /** Injectable for tests; defaults to the real loopback hook server. */
  startHookServer?: typeof startHookServerDefault;
  /** Injectable for tests; defaults to the real settings-file writer. */
  writeHookSettingsFile?: typeof writeHookSettingsFileDefault;
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
  /** True once `markWebTurnStart()` has fired and `markTurnEnd()` has not — introspection/tests. */
  isWebTurnActive: () => boolean;
  /** Call when a web-injected message starts a turn — routes this turn's tool prompts to the web. */
  markWebTurnStart: () => void;
  /** Call when the turn ends / control returns local — stops routing to the web. */
  markTurnEnd: () => void;
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

  let webTurnActive = false;
  const isWebTurnActive = () => webTurnActive;
  const markWebTurnStart = () => {
    webTurnActive = true;
    opts.logger?.debug("[remote-perm-hook] web turn started");
  };
  const markTurnEnd = () => {
    webTurnActive = false;
    opts.logger?.debug("[remote-perm-hook] turn ended");
  };

  const bridge = new PreToolPermissionBridge({
    emitEnvelope: opts.emitEnvelope,
    isWebTurnActive,
    onModeChange: opts.onModeChange,
    answerTimeoutMs: opts.answerTimeoutMs,
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
    isWebTurnActive,
    markWebTurnStart,
    markTurnEnd,
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
