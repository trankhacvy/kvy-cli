import { createEnvelope, type SessionEnvelope } from "@kvy/wire";
import type { Logger } from "../logger.js";
import {
  type ClaudeLocalDeps,
  claudeLocal as claudeLocalDefault,
  ExitCodeError,
} from "./claudeLocal.js";
import { createClaudeEnvelopeMapperState, mapClaudeToEnvelopes } from "./envelopeMapper.js";
import type { ModeSwitchDedupe, QueuedMessage } from "./loop.js";
import { createSessionScanner as createSessionScannerDefault } from "./scanner.js";

export interface ClaudeLocalLauncherOptions {
  workingDirectory: string;
  /** Provider session id to resume (e.g. carried over from a prior remote stop), or null for a fresh/whatever-claudeArgs-says session. */
  providerSessionId: string | null;
  claudeArgs?: string[];
  claudeEnvVars?: Record<string, string>;
  /** Fires as soon as the effective provider session id is known (offline-mode `onSessionFound`, or a resume). */
  onProviderSessionId: (id: string) => void;
  /** Every envelope the tailer maps off the transcript, already filtered through `dedupe`. Forward to the outbox. */
  onEnvelopes: (envelopes: SessionEnvelope[]) => void;
  onThinkingChange?: (thinking: boolean) => void;
  /** Shared cross-mode dedupe — suppresses transcript entries the remote SDK already emitted directly. */
  dedupe: ModeSwitchDedupe;
  logger?: Logger;
}

export interface ClaudeLocalLauncherDeps {
  /** Resolved path to `kvy_claude_launcher.cjs` — forwarded to `claudeLocal()` verbatim. */
  launcherPath: string;
  /** Injectable for tests; defaults to the real `claudeLocal()`. */
  claudeLocal?: typeof claudeLocalDefault;
  /** Injectable for tests; defaults to the real `createSessionScanner()`. */
  createSessionScanner?: typeof createSessionScannerDefault;
  spawnImpl?: ClaudeLocalDeps["spawnImpl"];
  findLastSession?: ClaudeLocalDeps["findLastSession"];
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  systemPrompt?: string;
}

export type ClaudeLocalLauncherResult =
  | { type: "exit"; code: number }
  | { type: "switch"; providerSessionId: string | null; queuedMessages: QueuedMessage[] };

export interface ClaudeLocalLauncherHandle {
  readonly done: Promise<ClaudeLocalLauncherResult>;
  /**
   * Requests an abort-and-switch-to-remote (a queued remote message or
   * `takeControl` RPC aborts the local child process). Safe to call more than
   * once — every call before the child exits queues its `message` (if any) for
   * delivery once remote mode starts; the abort itself only happens once.
   */
  requestSwitch(message?: QueuedMessage): void;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Starts one local-mode run. Returns a `{ done, requestSwitch }` handle so `loop.ts` can trigger a switch without waiting on the run. */
export function startClaudeLocalLauncher(
  opts: ClaudeLocalLauncherOptions,
  deps: ClaudeLocalLauncherDeps,
): ClaudeLocalLauncherHandle {
  const logger = deps.logger ?? opts.logger ?? noopLogger;
  const runClaudeLocal = deps.claudeLocal ?? claudeLocalDefault;
  const createScanner = deps.createSessionScanner ?? createSessionScannerDefault;

  const abortController = new AbortController();
  const queuedMessages: QueuedMessage[] = [];
  let switchRequested = false;

  function requestSwitch(message?: QueuedMessage): void {
    if (message) queuedMessages.push(message);
    if (switchRequested) return;
    switchRequested = true;
    logger.debug("[claude-local-launcher] switch requested — aborting local child");
    abortController.abort();
  }

  async function run(): Promise<ClaudeLocalLauncherResult> {
    const mapperState = createClaudeEnvelopeMapperState();
    let effectiveSessionId: string | null = opts.providerSessionId;

    const scanner = await createScanner({
      sessionId: opts.providerSessionId,
      workingDirectory: opts.workingDirectory,
      onMessage: (raw) => {
        const envelopes = mapClaudeToEnvelopes(raw, mapperState).filter(
          (envelope) => !opts.dedupe.isDuplicate(envelope),
        );
        if (envelopes.length > 0) opts.onEnvelopes(envelopes);
      },
      logger,
    });

    try {
      let resolvedSessionId: string | null;
      try {
        resolvedSessionId = await runClaudeLocal(
          {
            abort: abortController.signal,
            sessionId: opts.providerSessionId,
            workingDirectory: opts.workingDirectory,
            claudeArgs: opts.claudeArgs,
            claudeEnvVars: opts.claudeEnvVars,
            onSessionFound: (id) => {
              effectiveSessionId = id;
              opts.onProviderSessionId(id);
              void scanner.onNewSession(id);
            },
            onThinkingChange: opts.onThinkingChange,
          },
          {
            launcherPath: deps.launcherPath,
            spawnImpl: deps.spawnImpl,
            findLastSession: deps.findLastSession,
            env: deps.env,
            logger,
            systemPrompt: deps.systemPrompt,
          },
        );
      } catch (error) {
        if (error instanceof ExitCodeError) {
          if (switchRequested) {
            // A non-zero exit racing an in-flight abort is still a switch,
            // not a crash — the child going down is exactly what we asked for.
            // Emit the same mode-switch marker the clean-exit switch path
            // emits below — the timeline must not silently miss it just
            // because the abort happened to race a non-zero exit.
            opts.onEnvelopes([
              createEnvelope("agent", { t: "mode-switch", control: "remote", by: "client" }),
            ]);
            return {
              type: "switch",
              providerSessionId: effectiveSessionId,
              queuedMessages,
            };
          }
          return { type: "exit", code: error.exitCode };
        }
        throw error;
      }

      effectiveSessionId = resolvedSessionId ?? effectiveSessionId;

      if (switchRequested) {
        opts.onEnvelopes([
          createEnvelope("agent", { t: "mode-switch", control: "remote", by: "client" }),
        ]);
        return {
          type: "switch",
          providerSessionId: effectiveSessionId,
          queuedMessages,
        };
      }
      return { type: "exit", code: 0 };
    } finally {
      await scanner.cleanup();
    }
  }

  return { done: run(), requestSwitch };
}
