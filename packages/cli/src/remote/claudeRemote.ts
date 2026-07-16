/**
 * Ported (adapted) from Happy — https://github.com/slopus/happy
 * Original: happy-cli/src/claude/claudeRemote.ts (MIT)
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
 * Remote-mode Claude Code wrapper (plan.md §16 "2.1 Remote mode"; design
 * §7.4 "Remote mode"). Drives `@anthropic-ai/claude-agent-sdk`'s `query()`
 * with a `resume: providerSessionId`-capable, streaming-input session: one
 * `query()` call spans many user turns via a `PushableAsyncIterable` prompt
 * stream (`send()` pushes each new remote-composer message onto the SAME
 * stream rather than restarting `query()` per turn — matching how Happy's
 * `claudeRemoteLauncher.ts` keeps one `claudeRemote()` call alive across a
 * `while (!exitReason)` loop of turns).
 *
 * Scope note: this module owns exactly one `query()` instance's lifecycle —
 * send/interrupt/setMode/stop plus the SDK-message → envelope pipeline. The
 * orchestration that decides WHEN to start/stop one of these (mode-switch
 * triggers, the local↔remote state machine, cross-mode dedupe) is a
 * separate, not-yet-landed plan bullet (plan.md §16 "2.2 Mode switching":
 * "`loop.ts` port + `claudeLocalLauncher`/`claudeRemoteLauncher`
 * orchestrators") — deliberately out of scope here, same as `claudeLocal.ts`
 * treats its own launcher-script path as "a given" rather than building it.
 *
 * `canUseTool` defaults to a real `PermissionHandler` (plan.md §16 "2.3
 * Permission pipeline", design §7.6) wired to this query's own ordered
 * outgoing queue, so `perm-request`/`perm-resolve` envelopes are sequenced
 * alongside every other envelope this query produces. `ClaudeRemoteOptions.
 * canUseTool` still exists so tests (and, later, a shared cross-mode
 * permission handler instance) can override it. The handler's first-wins
 * `resolve()` is exposed as `ClaudeRemoteHandle.resolvePermission` — the
 * still-not-landed `perm.answer` session RPC handler (plan.md §16 "2.1
 * Remote mode" lists it; wiring `registerSessionRpcHandlers` to an actual
 * `ClaudeRemoteHandle` is `loop.ts`'s job, §2.2, not built yet) calls it.
 */
import { type CanUseTool, type Query, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AbortError } from "@anthropic-ai/claude-agent-sdk";
import { createEnvelope, type PermDecision, type PermissionMode, type SessionEnvelope } from "@falcon/wire";
import { FALCON_SYSTEM_PROMPT } from "../claude/claudeLocal.js";
import { type PermAnswerResult, PermissionHandler } from "../claude/permissionHandler.js";
import type { Logger } from "../logger.js";
import { OrderedEnvelopeQueue } from "./outgoingQueue.js";
import { PushableAsyncIterable } from "./pushableAsyncIterable.js";
import { SdkToEnvelopeConverter } from "./sdkToEnvelope.js";

export interface ClaudeRemoteOptions {
  /** cwd for the SDK-spawned Claude Code subprocess. */
  workingDirectory: string;
  /** `providerSessionId` to resume, or null/undefined to start a fresh session. */
  resume?: string | null;
  permissionMode: PermissionMode;
  model?: string;
  /** Defaults to a real `PermissionHandler`'s `canUseTool` — see the file header. */
  canUseTool?: CanUseTool;
  /** Every envelope this query produces, already strict-ordered (design §7.4). */
  onEnvelopes: (envelopes: SessionEnvelope[]) => void;
  /** Fires once per newly-observed `providerSessionId` (the SDK's own session_id — for resume, design §6.7). */
  onProviderSessionId?: (providerSessionId: string) => void;
  logger?: Logger;
}

export interface ClaudeRemoteHandle {
  /** Pushes a new user turn onto the live query — queued if a turn is in progress. */
  send(prompt: string): void;
  interrupt(): Promise<void>;
  setMode(mode: PermissionMode): Promise<void>;
  /** First-wins resolution for a pending `perm-request` (design §7.6's "Falcon add"). */
  resolvePermission(params: { reqId: string; decision: PermDecision }): PermAnswerResult;
  /** Ends the prompt stream and closes the query; resolves with the last known `providerSessionId`. */
  stop(): Promise<{ providerSessionId: string | null }>;
}

export interface ClaudeRemoteDeps {
  /** Injectable for tests; defaults to the real SDK `query`. */
  queryImpl?: typeof query;
  logger?: Logger;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function extractProviderSessionId(message: unknown): string | null {
  const raw = message as { session_id?: unknown } | null;
  return typeof raw?.session_id === "string" && raw.session_id.length > 0 ? raw.session_id : null;
}

/** Starts one `query()` instance and returns a handle to drive it. */
export function startClaudeRemote(
  opts: ClaudeRemoteOptions,
  deps: ClaudeRemoteDeps = {},
): ClaudeRemoteHandle {
  const logger = deps.logger ?? opts.logger ?? noopLogger;
  const queryImpl = deps.queryImpl ?? query;

  const prompts = new PushableAsyncIterable<SDKUserMessage>();
  const converter = new SdkToEnvelopeConverter();
  const outgoing = new OrderedEnvelopeQueue({
    onFlush: (envelope) => opts.onEnvelopes([envelope]),
  });

  let providerSessionId: string | null = opts.resume ?? null;
  let stopped = false;

  // Declared before `sdkQuery` is assigned so `onModeChange` can close over
  // it — a `perm.answer` decision that switches mode (design §7.6) must sync
  // the live SDK query the same way `setMode()` below does, since a custom
  // `canUseTool` fully replaces the SDK's own mode-based auto-approval.
  let sdkQuery: Query;
  const permissionHandler = new PermissionHandler({
    initialMode: opts.permissionMode,
    emitEnvelope: (envelope) => outgoing.push(envelope),
    onModeChange: (mode) => {
      sdkQuery.setPermissionMode(mode).catch((error) => {
        logger.debug("[claude-remote] failed to sync permission mode via SDK", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    logger,
  });

  sdkQuery = queryImpl({
    prompt: prompts,
    options: {
      cwd: opts.workingDirectory,
      resume: opts.resume ?? undefined,
      permissionMode: opts.permissionMode,
      model: opts.model,
      systemPrompt: { type: "preset", preset: "claude_code", append: FALCON_SYSTEM_PROMPT },
      canUseTool: opts.canUseTool ?? permissionHandler.canUseTool,
    },
  });

  function noteProviderSessionId(message: unknown): void {
    const sessionId = extractProviderSessionId(message);
    if (!sessionId || sessionId === providerSessionId) return;
    providerSessionId = sessionId;
    opts.onProviderSessionId?.(sessionId);
  }

  async function pump(): Promise<void> {
    try {
      for await (const message of sdkQuery) {
        noteProviderSessionId(message);
        outgoing.pushAll(converter.convert(message));
      }
    } catch (error) {
      if (error instanceof AbortError) {
        logger.debug("[claude-remote] query aborted");
        return;
      }
      logger.error("[claude-remote] query stream errored", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const pumped = pump();

  function send(prompt: string): void {
    // The turn this closes (if any) belongs to the PREVIOUS user message;
    // the human-typed prompt envelope is emitted here directly rather than
    // waiting for the SDK to (maybe) echo it back — see sdkToEnvelope.ts's
    // file header for why.
    outgoing.pushAll(converter.closeTurn("completed"));
    outgoing.push(createEnvelope("user", { t: "text", md: prompt }));

    prompts.push({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: prompt },
    });
  }

  async function interrupt(): Promise<void> {
    await sdkQuery.interrupt();
  }

  async function setMode(mode: PermissionMode): Promise<void> {
    await sdkQuery.setPermissionMode(mode);
    permissionHandler.setMode(mode);
  }

  function resolvePermission(params: { reqId: string; decision: PermDecision }): PermAnswerResult {
    return permissionHandler.resolve(params);
  }

  async function stop(): Promise<{ providerSessionId: string | null }> {
    if (stopped) {
      await pumped;
      return { providerSessionId };
    }
    stopped = true;

    try {
      await sdkQuery.interrupt();
    } catch (error) {
      logger.debug("[claude-remote] interrupt during stop failed (ignored)", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Cancel any permission request still awaiting a `perm.answer` — the
    // `canUseTool` promise it's blocking on must settle, not hang forever
    // against a handler nobody can reach once this query is gone (design:
    // "reset-on-mode-switch").
    permissionHandler.reset("Session stopped");

    prompts.end();
    outgoing.pushAll(converter.closeTurn("cancelled"));
    outgoing.flush();

    sdkQuery.close();
    await pumped;
    outgoing.dispose();

    return { providerSessionId };
  }

  return { send, interrupt, setMode, resolvePermission, stop };
}
