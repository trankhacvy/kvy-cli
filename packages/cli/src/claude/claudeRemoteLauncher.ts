import type { PermDecision, PermissionMode, SessionEnvelope } from "@kvy/wire";
import { createEnvelope } from "@kvy/wire";
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
  /** `~/.kvy` (or override) — passed to `AcpRemote` for the adapter manager's verify-before-spawn. */
  homeDir: string;
  /** Messages queued while local mode was aborting, delivered immediately once the session starts, in order. */
  initialMessages?: QueuedMessage[];
  /** Every envelope this session produces, already filtered through `dedupe`. Forward to the outbox. */
  onEnvelopes: (envelopes: SessionEnvelope[]) => void;
  /** Fires once per newly-observed `providerSessionId` (the ACP session id = provider session UUID). */
  onProviderSessionId?: (providerSessionId: string) => void;
  /** Fires when a turn reaches a terminal stopReason — used by the caller to complete the send claim. Does NOT fire on rejected/indeterminate prompts. */
  onTurnSettled?: (info: { messageId?: string; status: SessionTurnEndStatus }) => void;
  /** Shared cross-mode dedupe — suppresses envelopes the remote ACP session already emitted directly. */
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
  /** Injectable for tests; defaults to `ink`'s real `render`. Never called unless both stdout and stdin are a TTY. */
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

/** Starts one remote-mode run. Returns a handle so `loop.ts` can push events into the session without waiting on the run. */
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

  // Terminal UI — only active when both stdout and stdin are a TTY (tests and
  // piped/non-interactive invocations take `hasTTY === false`).
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

    // Hand the terminal back cleanly before returning — needed for every
    // outcome (exit or switch-to-local): an `exit` still needs the terminal
    // restored for whatever comes next (the shell prompt).
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
