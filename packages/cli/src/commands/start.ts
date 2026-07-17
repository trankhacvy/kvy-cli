/**
 * `falcon claude [args...]` (plan.md §16 "1.3 CLI skeleton + local mode" /
 * "2.2 Mode switching") — the first real (non-stub) provider spawn. Every
 * piece this wires together already existed and was already unit-tested in
 * isolation (`session/bootstrap.ts`, `api/outbox.ts`, `claude/loop.ts` +
 * `claude/claudeLocalLauncher.ts`, `provider/claudeCliLocator.ts`,
 * `session/sessionClient.ts`, `rpc/sessionRpc.ts`) — nothing here is new
 * logic, only composition. Codex has no local-interactive mode
 * (`codex/index.ts`'s `CODEX_NO_LOCAL_MODE_NOTE`), so `index.ts`'s `runStart`
 * only reaches this module for `provider === "claude"`; every other provider
 * keeps going through the honest `describeStart` stub.
 *
 * This module opens the session-scoped `/v1/stream` connection
 * (`session/sessionClient.ts`) and registers the five session RPCs
 * (`rpc/sessionRpc.ts`) over it, so a `message`/`takeControl` sent from the
 * web UI actually reaches `loop()`: `message`/`takeControl` are routed
 * through a tiny local pub-sub that `onMessage`/`onTakeControl` subscribe to
 * (previously no-op stubs — nothing could ever reach `loop()`, which is why
 * the web Composer's "RPC target not available" error happened: nothing on
 * the CLI side ever joined the `s:<sessionId>:<method>` room the server's
 * relay looks up). `interrupt`/`setMode`/`perm.answer` have no existing hook
 * to call into yet (`claudeLocalLauncher.ts` has no "interrupt without
 * switching" primitive, `claudeRemoteLauncher.ts`'s handle doesn't expose
 * the underlying `ClaudeRemoteHandle`'s `interrupt`/`setMode`/
 * `resolvePermission`, and local mode can't answer a permission prompt that
 * doesn't exist on this path per plan.md's "Local-mode honesty" FR-3.6) —
 * each returns an honest not-supported result rather than a fake success.
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
import type { ClaudeLocalLauncherDeps } from "../claude/claudeLocalLauncher.js";
import type { ClaudeRemoteLauncherDeps } from "../claude/claudeRemoteLauncher.js";
import {
  type ClaudeMode,
  type LoopDeps,
  type LoopOptions,
  type QueuedMessage,
  loop as loopDefault,
} from "../claude/loop.js";
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
  /** Injectable for tests; defaults to the real mode loop. */
  loop?: (options: LoopOptions, loopDeps: LoopDeps) => Promise<number>;
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
  const runLoop = deps.loop ?? loopDefault;
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

  // Real cross-install-method location found above — thread it through so
  // `falcon_claude_launcher.cjs`'s own `getClaudeCliPath()` (a deliberate
  // local stub, per its file header: "will [be] replace[d] ... at
  // integration time") uses the resolver instead of falling back to a bare
  // `"claude"` PATH lookup.
  const localLauncherDeps: ClaudeLocalLauncherDeps = {
    launcherPath: deps.launcherPath,
    logger,
  };
  // Defaults-only — `loop()` only reaches `startClaudeRemoteLauncher(...,
  // deps.remote)` once something (the `message`/`takeControl` RPCs wired
  // below) actually requests a local→remote switch, but it must be a real
  // object rather than left undefined so that switch doesn't crash on a
  // missing dep the moment it happens.
  const remoteLauncherDeps: ClaudeRemoteLauncherDeps = {};

  const permissionMode: PermissionMode = "default";
  const noUnsubscribe = () => () => {};

  // The session-scoped `/v1/stream` connection `message`/`interrupt`/
  // `takeControl`/`setMode`/`perm.answer` arrive over (design §4.4). Without
  // this, nothing on the CLI side ever joins the `s:<sessionId>:<method>`
  // room the server's RPC relay looks up — the bug this task fixes.
  const sessionClient = startSessionClient(
    createSessionClientDeps(
      { serverUrl: backendUrl, token: credentials.token, sessionId: bootstrap.sessionId },
      { logger },
    ),
  );

  // Local pub-sub `loop()`'s `onMessage`/`onTakeControl` registration
  // functions subscribe to — the session RPC handlers below are the only
  // producers. `currentMode` (updated via `onModeChange`) lets the
  // `message` handler give an honest `queued` answer: true while local mode
  // is still aborting/switching, false once a remote query can take the
  // message directly.
  const messageSignal = createSignal<QueuedMessage>();
  const takeControlSignal = createSignal<void>();
  let currentMode: ClaudeMode = "local";

  const rpcHandlers: SessionRpcHandlers = {
    message: async ({ envelope }) => {
      if (envelope.ev.t !== "text") {
        logger.warn("[start-claude] message RPC delivered a non-text envelope; dropping", {
          type: envelope.ev.t,
        });
        return { queued: false };
      }
      const queued = currentMode === "local";
      messageSignal.emit({ id: envelope.id, text: envelope.ev.md });
      return { queued };
    },
    takeControl: async () => {
      takeControlSignal.emit();
      return { ok: true };
    },
    // No existing hook: `claudeLocalLauncher.ts` only knows how to abort-
    // and-switch-to-remote, not "interrupt the current turn and stay
    // local"; `claudeRemoteLauncher.ts`'s handle doesn't expose the
    // underlying SDK query's own `interrupt()` either. Honest
    // not-supported rather than a silent no-op that looks like success.
    interrupt: async () => {
      logger.warn("[start-claude] interrupt RPC received — not wired yet, no-op");
      return { ok: false };
    },
    // Same gap as `interrupt`: `loop.ts` reads `permissionMode` once at
    // startup and has no live hook to change it mid-run.
    setMode: async () => {
      logger.warn("[start-claude] setMode RPC received — not wired yet, no-op");
      return { ok: false };
    },
    // plan.md's "Local-mode honesty" (FR-3.6): local mode can't answer a
    // permission prompt on the provider's own TTY — never fake resolving
    // one. (Remote mode has no wiring for this yet either — same gap as
    // `interrupt`/`setMode` above — so the honest answer applies either way.)
    permAnswer: async () => {
      logger.warn("[start-claude] perm.answer RPC received — not answerable on this path yet");
      return { ok: false };
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
        startingMode: "local",
        permissionMode,
        claudeArgs: deps.claudeArgs,
        claudeEnvVars: { FALCON_CLAUDE_PATH: location.path },
        onEnvelopes: (envelopes) => outbox.enqueue(envelopes),
        onModeChange: (mode) => {
          currentMode = mode;
        },
        onMessage: (handler) => messageSignal.subscribe(handler),
        onTakeControl: (handler) => takeControlSignal.subscribe(handler),
        onExitRequested: noUnsubscribe,
        logger,
      },
      { local: localLauncherDeps, remote: remoteLauncherDeps },
    );
  } finally {
    rpcHandle.stop();
    sessionClient.stop();
    outbox.dispose();
  }
}
