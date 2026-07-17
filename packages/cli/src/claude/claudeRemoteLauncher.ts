/**
 * Ported (adapted) from Happy — https://github.com/slopus/happy
 * Original: happy-cli/src/claude/claudeRemoteLauncher.ts (MIT) — plan.md §16
 * "2.2 Mode switching": "`loop.ts` port + `claudeLocalLauncher`/
 * `claudeRemoteLauncher` orchestrators"; "remote→local: SDK stop → capture
 * new providerSessionId → `claude --resume <id>` → `mode-switch`".
 *
 * MIT License
 * Copyright (c) 2026 Happy Coder Contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * ---
 * Orchestrates ONE remote-mode run: starts the ACP-driven `startAcpRemote()`
 * session (design §7.4 v0.3 — v2 replaced the SDK `startClaudeRemote()` this
 * launcher used to drive), feeds it any messages queued during a prior
 * local→remote switch plus any that arrive mid-run, and reports back either
 * a clean `exit` (double-Ctrl-C) or a `switch`-to-local (capturing the ACP
 * session id — which IS the Claude Code session UUID, design §7.4 — so the
 * caller can `claude --resume <id>`, per plan.md §6.7).
 *
 * Returns a handle (`{ done, deliverMessage, interrupt, setMode,
 * resolvePermission, requestSwitchToLocal, requestExit }`) so `loop.ts` can
 * push events into the currently-running launcher without waiting on (or
 * restructuring around) the async run itself — same shape
 * `claudeLocalLauncher.ts` uses. `interrupt`/`setMode`/`resolvePermission`
 * delegate straight to the underlying `AcpRemoteHandle`, so the session RPCs
 * (`interrupt`/`setMode`/`perm.answer`) reach a live remote turn.
 *
 * ## Scope note
 * This module does not own the RPC transport that decides *when* its handle
 * methods get called from the web (that's `loop.ts`/the session-RPC wiring's
 * job) — but it DOES own `RemoteModeDisplay`'s Ctrl-T/double-space/
 * double-Ctrl-C local-terminal gestures, same as Happy's own
 * `claudeRemoteLauncher.ts`: they call the same `requestSwitchToLocal`/
 * `requestExit` a remote RPC would. The HTTP outbox (`onEnvelopes` is a plain
 * callback the caller wires to `Outbox.enqueue`) is out of scope here. The
 * permission pipeline is now owned by `AcpRemote`'s own `AcpPermissionHandler`
 * (design §7.6) — no `canUseTool` seam anymore; `resolvePermission` on the
 * handle is how a `perm.answer` RPC reaches it.
 *
 * ## Send-idempotency (design §7.10)
 * `onTurnSettled` is threaded straight to `AcpRemote`: it fires with the
 * originating message's id once its turn reached a terminal stopReason, and
 * NOT if the turn's prompt was rejected (adapter died) — the caller
 * (`commands/start.ts`) uses it to complete the send claim, leaving it open
 * on an indeterminate outcome.
 *
 * ## Terminal UI (ported from Happy's own claudeRemoteLauncher.ts)
 * Renders the already-ported `RemoteModeDisplay` Ink component when stdout/
 * stdin are both a TTY (never in a non-interactive/piped/test context —
 * `hasTTY` gates all of the below, matching Happy exactly), feeding it the
 * same `SessionEnvelope`s the outbox gets via `MessageBuffer`/
 * `pushEnvelopeToBuffer` (`remote/messageBuffer.ts`) rather than re-deriving
 * a second summary of the raw SDK stream. On the way out, `cleanupStdinAfterInk`
 * (ported verbatim from Happy — see its own file header) drains any stray
 * keystrokes and deliberately leaves raw mode ON, because the next consumer
 * on a switch-to-local is `claude` itself via `stdio: 'inherit'`, which
 * expects to inherit a raw-mode-capable stdin — resetting to cooked mode
 * here would open a race window where the kernel echoes in-flight bytes at
 * wherever Ink last left the cursor (visible garbage / a "second cursor").
 */
import type { PermDecision, PermissionMode, SessionEnvelope } from "@falcon/wire";
import { createEnvelope } from "@falcon/wire";
import { render as inkRenderDefault } from "ink";
import React from "react";
import type { PermAnswerResult } from "../acp/acpPermissionHandler.js";
import { startAcpRemote as startAcpRemoteDefault } from "../acp/acpRemote.js";
import type { SessionTurnEndStatus } from "../acp/acpToEnvelope.js";
import type { Logger } from "../logger.js";
import { MessageBuffer, pushEnvelopeToBuffer } from "../remote/messageBuffer.js";
import { RemoteModeDisplay } from "../remote/RemoteModeDisplay.js";
import { cleanupStdinAfterInk } from "../remote/terminalStdinCleanup.js";
import type { ModeSwitchDedupe, QueuedMessage } from "./loop.js";

/** Minimal surface this module needs from an Ink render instance — matches what `ink`'s `render()` returns. */
interface InkInstance {
  unmount: () => void;
}

/** Injectable so tests never actually mount Ink or touch real stdin/stdout. Defaults to `ink`'s real `render`. */
type InkRender = (element: React.ReactElement, options?: Record<string, unknown>) => InkInstance;

export interface ClaudeRemoteLauncherOptions {
  workingDirectory: string;
  /** `providerSessionId` to resume, or null/undefined to start a fresh session. */
  providerSessionId?: string | null;
  permissionMode: PermissionMode;
  model?: string;
  /** `~/.falcon` (or override) — passed to `AcpRemote` for the adapter manager's verify-before-spawn. */
  homeDir: string;
  /** Messages queued while local mode was aborting, delivered immediately once the session starts, in order. */
  initialMessages?: QueuedMessage[];
  /** Every envelope this session produces, already filtered through `dedupe`. Forward to the outbox. */
  onEnvelopes: (envelopes: SessionEnvelope[]) => void;
  /** Fires once per newly-observed `providerSessionId` (the ACP session id = provider session UUID). */
  onProviderSessionId?: (providerSessionId: string) => void;
  /** Fires when a turn reaches a terminal stopReason — the send-claim completion hook (file header, design §7.10). */
  onTurnSettled?: (info: { messageId?: string; status: SessionTurnEndStatus }) => void;
  /** Shared cross-mode dedupe (plan.md §6.7) — see `loop.ts`'s file header. */
  dedupe: ModeSwitchDedupe;
  logger?: Logger;
}

/** Minimal stdin/stdout surface this module needs — matches the real `process.stdin`/`process.stdout`, injectable so tests never touch the real terminal. */
interface TerminalStdio {
  stdout: { isTTY?: boolean };
  stdin: {
    isTTY?: boolean;
    on: (event: "data", listener: (chunk: unknown) => void) => unknown;
    off: (event: "data", listener: (chunk: unknown) => void) => unknown;
    resume: () => void;
    pause: () => void;
    setEncoding?: (encoding: BufferEncoding) => unknown;
    setRawMode?: (value: boolean) => void;
  };
}

export interface ClaudeRemoteLauncherDeps {
  /** Injectable for tests; defaults to the real `startAcpRemote()`. */
  startAcpRemote?: typeof startAcpRemoteDefault;
  /** Injectable for tests; defaults to `ink`'s real `render`. Never called unless `hasTTY` (see file header). */
  render?: InkRender;
  /** Injectable for tests; defaults to the real `process.stdout`/`process.stdin`. */
  terminal?: TerminalStdio;
  logger?: Logger;
}

export type ClaudeRemoteLauncherResult =
  | { type: "exit" }
  | { type: "switch"; providerSessionId: string | null };

export interface ClaudeRemoteLauncherHandle {
  readonly done: Promise<ClaudeRemoteLauncherResult>;
  /** Delivers a message arriving mid-run (the `message` RPC) directly into the live session. */
  deliverMessage(message: QueuedMessage): void;
  /** Cancels the in-flight turn (`interrupt` RPC) — no-op once the run has settled. */
  interrupt(): Promise<void>;
  /** Syncs the live session's permission mode (`setMode` RPC) — no-op once the run has settled. */
  setMode(mode: PermissionMode): Promise<void>;
  /** First-wins resolution for a pending `perm-request` (the `perm.answer` RPC). */
  resolvePermission(params: { reqId: string; decision: PermDecision }): PermAnswerResult;
  /**
   * Requests handing control back to the terminal (`takeControl` RPC, or
   * Ctrl-T/double-space-confirm in `RemoteModeDisplay`). Idempotent —
   * only the first call decides the outcome.
   */
  requestSwitchToLocal(): void;
  /** Requests exiting the whole client (double-Ctrl-C). Idempotent — only the first call decides the outcome. */
  requestExit(): void;
}

/** Result of a `perm.answer` against a launcher that has already settled (no live remote to resolve against). */
const NO_ACTIVE_REMOTE_PERM_RESULT: PermAnswerResult = { ok: false, reason: "already-answered" };

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Starts one remote-mode run. See file header for the handle-based shape. */
export function startClaudeRemoteLauncher(
  opts: ClaudeRemoteLauncherOptions,
  deps: ClaudeRemoteLauncherDeps = {},
): ClaudeRemoteLauncherHandle {
  const logger = deps.logger ?? opts.logger ?? noopLogger;
  const start = deps.startAcpRemote ?? startAcpRemoteDefault;
  const inkRender = deps.render ?? (inkRenderDefault as InkRender);
  const terminal: TerminalStdio = deps.terminal ?? { stdout: process.stdout, stdin: process.stdin };

  let outcome: "switch" | "exit" | null = null;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  function requestSwitchToLocal(): void {
    if (outcome) return;
    outcome = "switch";
    logger.debug("[claude-remote-launcher] switch-to-local requested");
    resolveSettled();
  }

  function requestExit(): void {
    if (outcome) return;
    outcome = "exit";
    logger.debug("[claude-remote-launcher] exit requested");
    resolveSettled();
  }

  // Terminal UI — see file header. Never touches the real terminal outside a
  // real interactive TTY session (both this repo's tests and any piped/
  // non-interactive invocation naturally take `hasTTY === false`, matching
  // Happy's own gate exactly).
  const messageBuffer = new MessageBuffer();
  const hasTTY = Boolean(terminal.stdout.isTTY && terminal.stdin.isTTY);
  let inkInstance: InkInstance | null = null;

  if (hasTTY) {
    console.clear();
    inkInstance = inkRender(
      React.createElement(RemoteModeDisplay, {
        messageBuffer,
        onExit: requestExit,
        onSwitchToLocal: requestSwitchToLocal,
      }),
      { exitOnCtrlC: false, patchConsole: false },
    );
    terminal.stdin.resume();
    if (terminal.stdin.isTTY) terminal.stdin.setRawMode?.(true);
    terminal.stdin.setEncoding?.("utf8");
  }

  const handle = start(
    {
      workingDirectory: opts.workingDirectory,
      resume: opts.providerSessionId,
      permissionMode: opts.permissionMode,
      model: opts.model,
      homeDir: opts.homeDir,
      onEnvelopes: (envelopes) => {
        const forwarded = envelopes.filter((envelope) => !opts.dedupe.isDuplicate(envelope));
        if (forwarded.length === 0) return;
        for (const envelope of forwarded) pushEnvelopeToBuffer(messageBuffer, envelope);
        opts.onEnvelopes(forwarded);
      },
      onProviderSessionId: opts.onProviderSessionId,
      onTurnSettled: opts.onTurnSettled,
      logger,
    },
    {},
  );

  for (const message of opts.initialMessages ?? []) handle.send(message.text, message.id);

  function deliverMessage(message: QueuedMessage): void {
    if (outcome) {
      logger.debug("[claude-remote-launcher] dropping message delivered after settle", {
        id: message.id,
      });
      return;
    }
    handle.send(message.text, message.id);
  }

  async function interrupt(): Promise<void> {
    if (outcome) return;
    await handle.interrupt();
  }

  async function setMode(mode: PermissionMode): Promise<void> {
    if (outcome) return;
    await handle.setMode(mode);
  }

  function resolvePermission(params: { reqId: string; decision: PermDecision }): PermAnswerResult {
    if (outcome) return NO_ACTIVE_REMOTE_PERM_RESULT;
    return handle.resolvePermission(params);
  }

  async function run(): Promise<ClaudeRemoteLauncherResult> {
    await settled;
    const { providerSessionId } = await handle.stop();

    // Hand the terminal back cleanly before returning — see file header for
    // why this must happen for every outcome (exit or switch-to-local), not
    // just the switch path: an `exit` still needs the terminal restored to
    // whatever comes next (the shell prompt).
    if (inkInstance) {
      inkInstance.unmount();
      await cleanupStdinAfterInk({ stdin: terminal.stdin, drainMs: 150 });
    }
    messageBuffer.clear();

    if (outcome === "exit") {
      return { type: "exit" };
    }

    opts.onEnvelopes([
      createEnvelope("agent", { t: "mode-switch", control: "local", by: "client" }),
    ]);
    return { type: "switch", providerSessionId };
  }

  return {
    done: run(),
    deliverMessage,
    interrupt,
    setMode,
    resolvePermission,
    requestSwitchToLocal,
    requestExit,
  };
}
