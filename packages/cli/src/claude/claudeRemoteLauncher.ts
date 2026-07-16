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
 * Orchestrates ONE remote-mode run: starts the already-built
 * `startClaudeRemote()` SDK-driven query, feeds it any messages queued
 * during a prior local→remote switch plus any that arrive mid-run, and
 * reports back either a clean `exit` (double-Ctrl-C) or a `switch`-to-local
 * (capturing the SDK's own `providerSessionId` so the caller can
 * `claude --resume <id>`, per plan.md §6.7). This is exactly the
 * orchestration `claudeRemote.ts`'s own file header calls out as
 * deliberately out of its scope: "the orchestration that decides WHEN to
 * start/stop one of these ... is a separate, not-yet-landed plan bullet".
 *
 * Returns a handle (`{ done, deliverMessage, requestSwitchToLocal,
 * requestExit }`) so `loop.ts` can push events into the currently-running
 * launcher without waiting on (or restructuring around) the async run
 * itself — same shape `claudeLocalLauncher.ts` uses.
 *
 * ## Scope note
 * This module does not own the RPC/keypress transport that decides *when*
 * `deliverMessage()`/`requestSwitchToLocal()`/`requestExit()` get called
 * (that's `loop.ts`'s job — it wires the session `message`/`takeControl`
 * RPCs and `RemoteModeDisplay`'s Ctrl-T/double-space/double-Ctrl-C gestures
 * into these three calls), the HTTP outbox (`onEnvelopes` is a plain
 * callback the caller wires to `Outbox.enqueue`), or the real permission
 * pipeline (`canUseTool` defaults to `claudeRemote.ts`'s own fail-closed
 * stub, same as it already does — plan.md §2.3, a separate task).
 */
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { createEnvelope, type PermissionMode, type SessionEnvelope } from "@falcon/wire";
import type { Logger } from "../logger.js";
import { startClaudeRemote as startClaudeRemoteDefault } from "../remote/claudeRemote.js";
import type { ModeSwitchDedupe, QueuedMessage } from "./loop.js";

export interface ClaudeRemoteLauncherOptions {
  workingDirectory: string;
  /** `providerSessionId` to resume, or null/undefined to start a fresh session. */
  providerSessionId?: string | null;
  permissionMode: PermissionMode;
  model?: string;
  /** Defaults to `claudeRemote.ts`'s own fail-closed stub — see file header. */
  canUseTool?: CanUseTool;
  /** Messages queued while local mode was aborting, delivered immediately once the query starts, in order. */
  initialMessages?: QueuedMessage[];
  /** Every envelope this query produces, already filtered through `dedupe`. Forward to the outbox. */
  onEnvelopes: (envelopes: SessionEnvelope[]) => void;
  /** Fires once per newly-observed `providerSessionId` (the SDK's own session_id). */
  onProviderSessionId?: (providerSessionId: string) => void;
  /** Shared cross-mode dedupe (plan.md §6.7) — see `loop.ts`'s file header. */
  dedupe: ModeSwitchDedupe;
  logger?: Logger;
}

export interface ClaudeRemoteLauncherDeps {
  /** Injectable for tests; defaults to the real `startClaudeRemote()`. */
  startClaudeRemote?: typeof startClaudeRemoteDefault;
  logger?: Logger;
}

export type ClaudeRemoteLauncherResult =
  | { type: "exit" }
  | { type: "switch"; providerSessionId: string | null };

export interface ClaudeRemoteLauncherHandle {
  readonly done: Promise<ClaudeRemoteLauncherResult>;
  /** Delivers a message arriving mid-run (the `message` RPC) directly into the live query. */
  deliverMessage(message: QueuedMessage): void;
  /**
   * Requests handing control back to the terminal (`takeControl` RPC, or
   * Ctrl-T/double-space-confirm in `RemoteModeDisplay`). Idempotent —
   * only the first call decides the outcome.
   */
  requestSwitchToLocal(): void;
  /** Requests exiting the whole client (double-Ctrl-C). Idempotent — only the first call decides the outcome. */
  requestExit(): void;
}

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
  const start = deps.startClaudeRemote ?? startClaudeRemoteDefault;

  let outcome: "switch" | "exit" | null = null;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  const handle = start(
    {
      workingDirectory: opts.workingDirectory,
      resume: opts.providerSessionId,
      permissionMode: opts.permissionMode,
      model: opts.model,
      canUseTool: opts.canUseTool,
      onEnvelopes: (envelopes) => {
        const forwarded = envelopes.filter((envelope) => !opts.dedupe.isDuplicate(envelope));
        if (forwarded.length > 0) opts.onEnvelopes(forwarded);
      },
      onProviderSessionId: opts.onProviderSessionId,
      logger,
    },
    {},
  );

  for (const message of opts.initialMessages ?? []) handle.send(message.text);

  function deliverMessage(message: QueuedMessage): void {
    if (outcome) {
      logger.debug("[claude-remote-launcher] dropping message delivered after settle", {
        id: message.id,
      });
      return;
    }
    handle.send(message.text);
  }

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

  async function run(): Promise<ClaudeRemoteLauncherResult> {
    await settled;
    const { providerSessionId } = await handle.stop();

    if (outcome === "exit") {
      return { type: "exit" };
    }

    opts.onEnvelopes([
      createEnvelope("agent", { t: "mode-switch", control: "local", by: "client" }),
    ]);
    return { type: "switch", providerSessionId };
  }

  return { done: run(), deliverMessage, requestSwitchToLocal, requestExit };
}
