/**
 * `falcon codex [args...]` (design §7.7 "Codex adapter (v0.3 — ACP)", plan.md
 * §17 Phase 2.3). Codex has no local-interactive TUI, so — unlike `falcon
 * claude`'s local↔remote mode loop (`commands/start.ts`) — a Codex session is
 * **remote from the start**: it drives one `AcpRemote` on the `codex-acp`
 * adapter for its whole lifetime, with no `loop()` and no local child.
 *
 * The surrounding scaffolding is the same a `falcon claude` session uses
 * (bootstrap → outbox → session-scoped WS + the five session RPCs → the
 * send-idempotency claim store), just without the mode machinery: the
 * `message`/`interrupt`/`setMode`/`perm.answer` RPCs route straight into the
 * `AcpRemoteHandle`. `takeControl` has no meaning here (there is no local
 * terminal to hand control back to) and answers an honest `{ok:false}`.
 *
 * exec/patch approvals arrive through ACP's standard
 * `session/request_permission` → the same `AcpPermissionHandler` Claude uses
 * (design §7.6), so nothing Codex-specific is needed on the permission path.
 */
import path from "node:path";
import { decodeBase64, deriveKeyTree } from "@falcon/crypto";
import { createId } from "@paralleldrive/cuid2";
import { startAcpRemote as startAcpRemoteDefault } from "../acp/acpRemote.js";
import { createHttpClient } from "../api/httpClient.js";
import { Outbox } from "../api/outbox.js";
import { resolveBackendUrl } from "../auth/config.js";
import {
  type FalconCredentials,
  readCredentials as readCredentialsDefault,
} from "../auth/credentials.js";
import { claimMessageSend, completeMessageSend } from "../claims/claimStore.js";
import {
  CODEX_NO_LOCAL_MODE_NOTE,
  type DetectCodexOptions,
  detectCodex as detectCodexDefault,
  type ProviderDetectionResult,
} from "../codex/index.js";
import { type DaemonState, readDaemonState as readDaemonStateDefault } from "../daemon/state.js";
import type { Logger } from "../logger.js";
import { registerSessionRpcHandlers, type SessionRpcHandlers } from "../rpc/sessionRpc.js";
import {
  bootstrapSession as bootstrapSessionDefault,
  createBootstrapSessionDeps,
} from "../session/bootstrap.js";
import { extractModelFlag } from "../session/modelFlag.js";
import {
  createSessionClientDeps,
  startSessionClient as startSessionClientDefault,
} from "../session/sessionClient.js";

const MASTER_SECRET_LENGTH_BYTES = 32;
const NOT_LOGGED_IN_MESSAGE = 'falcon: not logged in — run "falcon auth login" first\n';

const MACHINE_ID_WAIT_TIMEOUT_MS = 3000;
const MACHINE_ID_POLL_MS = 100;

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface StartCodexCommandDeps {
  homeDir: string;
  workingDirectory: string;
  codexArgs: string[];
  env?: NodeJS.ProcessEnv;
  backendUrl?: string;
  readCredentials?: (homeDir: string) => FalconCredentials | null;
  readDaemonState?: (homeDir: string) => Promise<DaemonState | null>;
  fetchImpl?: typeof fetch;
  detectCodex?: (options?: DetectCodexOptions) => Promise<ProviderDetectionResult>;
  bootstrapSession?: typeof bootstrapSessionDefault;
  startAcpRemote?: typeof startAcpRemoteDefault;
  startSessionClient?: typeof startSessionClientDefault;
  registerSessionRpcHandlers?: typeof registerSessionRpcHandlers;
  /**
   * Resolves when the session should end (Ctrl-C at the terminal). Injectable
   * so tests drive the lifetime without a real signal; defaults to a
   * one-shot `SIGINT` listener.
   */
  waitForExit?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
  logger?: Logger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForSigint(): Promise<void> {
  return new Promise((resolve) => {
    const onSigint = () => {
      process.off("SIGINT", onSigint);
      resolve();
    };
    process.on("SIGINT", onSigint);
  });
}

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

/** Runs `falcon codex [args...]`. Returns the process exit code. */
export async function runStartCodexCommand(deps: StartCodexCommandDeps): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const writeError = deps.writeError ?? ((text: string) => process.stderr.write(text));
  const logger = deps.logger ?? noopLogger;
  const env = deps.env ?? process.env;
  const readCreds = deps.readCredentials ?? readCredentialsDefault;
  const readState = deps.readDaemonState ?? readDaemonStateDefault;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const detect = deps.detectCodex ?? detectCodexDefault;
  const doBootstrapSession = deps.bootstrapSession ?? bootstrapSessionDefault;
  const startAcpRemote = deps.startAcpRemote ?? startAcpRemoteDefault;
  const startSessionClient = deps.startSessionClient ?? startSessionClientDefault;
  const registerRpc = deps.registerSessionRpcHandlers ?? registerSessionRpcHandlers;
  const waitForExit = deps.waitForExit ?? waitForSigint;

  // 1. Credentials first — never touch the network without them.
  const credentials = readCreds(deps.homeDir);
  if (!credentials) {
    writeError(NOT_LOGGED_IN_MESSAGE);
    return 1;
  }

  // 2. Fail honestly if the Codex CLI (its `app-server` the adapter drives)
  // isn't installed.
  const detection = await detect({ env });
  if (!detection.installed) {
    writeError(`falcon codex: ${detection.error ?? "Codex CLI is not installed."}\n`);
    return 1;
  }

  const masterSecret = decodeBase64(credentials.masterSecretOrContentBundle);
  if (masterSecret.length !== MASTER_SECRET_LENGTH_BYTES) {
    writeError(
      "falcon codex: stored credentials can't derive a content key for local sessions (reduced-custody pairing?) — run `falcon auth login` on this machine\n",
    );
    return 1;
  }
  const { content: contentKeyPair } = deriveKeyTree(masterSecret);

  const machineId = await waitForMachineId(deps.homeDir, {
    readDaemonState: readState,
    sleep: deps.sleep ?? sleep,
    now: deps.now ?? Date.now,
  });
  if (!machineId) {
    writeError(
      "falcon codex: this machine hasn't finished registering with the Falcon server yet — try again in a few seconds (see `falcon daemon status`)\n",
    );
    return 1;
  }

  const backendUrl = deps.backendUrl ?? resolveBackendUrl(env);

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
        provider: "codex",
        contentKeyPair,
        metadata: {
          title: path.basename(deps.workingDirectory) || deps.workingDirectory,
          path: deps.workingDirectory,
          model: extractModelFlag(deps.codexArgs),
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[start-codex] bootstrapSession failed", { message });
    writeError(`falcon codex: failed to start session — ${message}\n`);
    return 1;
  }

  write(`falcon codex: starting session ${bootstrap.sessionId}\n${CODEX_NO_LOCAL_MODE_NOTE}\n`);

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

  const sessionClient = startSessionClient(
    createSessionClientDeps(
      { serverUrl: backendUrl, token: credentials.token, sessionId: bootstrap.sessionId },
      { logger },
    ),
  );

  // envelopeId -> claimId, so the turn-settle hook completes exactly the
  // claim its `message` handler opened (design §7.10).
  const openClaims = new Map<string, string>();

  // "End session" from the web (plan-v2.md W2.3): there is no terminal-side
  // exit signal here (unlike `start.ts`'s `loop()`, which already has a
  // `requestExit()`-shaped hook) — Codex's whole lifetime is gated on
  // `waitForExit()` (SIGINT by default), so the `stop` RPC resolves a second,
  // manually-triggered promise raced against it below.
  let requestExit = () => {};
  const exitRequested = new Promise<void>((resolve) => {
    requestExit = resolve;
  });

  const remote = startAcpRemote({
    adapterId: "codex",
    workingDirectory: deps.workingDirectory,
    permissionMode: "default",
    homeDir: deps.homeDir,
    onEnvelopes: (envelopes) => outbox.enqueue(envelopes),
    onTurnSettled: ({ messageId, status }) => {
      if (!messageId) return;
      const claimId = openClaims.get(messageId);
      if (!claimId) return;
      openClaims.delete(messageId);
      void completeMessageSend(
        bootstrap.sessionId,
        messageId,
        claimId,
        { status },
        { homeDir: deps.homeDir },
      ).catch((error: unknown) => {
        logger.warn("[start-codex] failed to complete send claim", {
          id: messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    logger,
  });

  const rpcHandlers: SessionRpcHandlers = {
    message: async ({ envelope }) => {
      if (envelope.ev.t !== "text") {
        logger.warn("[start-codex] message RPC delivered a non-text envelope; dropping", {
          type: envelope.ev.t,
        });
        return { queued: false };
      }
      const claim = await claimMessageSend(bootstrap.sessionId, envelope.id, {
        homeDir: deps.homeDir,
      });
      if (claim.status === "completed") {
        return { queued: false, status: "duplicate" };
      }
      if (claim.status === "in-progress") {
        logger.warn(
          "[start-codex] message RPC outcome indeterminate — open claim, not re-running",
          {
            id: envelope.id,
          },
        );
        return { queued: false, status: "outcome-unknown" };
      }
      openClaims.set(envelope.id, claim.claimId);
      // Always remote: the message is delivered straight into the live turn
      // queue, never "queued for a mode switch".
      remote.send(envelope.ev.md, envelope.id);
      return { queued: false, status: "queued" };
    },
    interrupt: async () => {
      await remote.interrupt();
      return { ok: true };
    },
    setMode: async ({ mode }) => {
      await remote.setMode(mode);
      return { ok: true };
    },
    // Codex has no local terminal to hand control back to (design §7.7) —
    // honest not-supported rather than a fake success.
    takeControl: () => {
      logger.debug("[start-codex] takeControl RPC — Codex has no local mode to return to");
      return { ok: false };
    },
    permAnswer: ({ reqId, decision }) => remote.resolvePermission({ reqId, decision }),
    // Same not-yet-landed status-reporting caveat as `start.ts`'s `stop`
    // handlers (plan-v2.md U1.4 "lifecycle-status" hasn't landed on this
    // branch — see that comment). `force` doesn't kill anything directly;
    // it exits this whole CLI process after a grace period if `remote.stop()`
    // hasn't already ended the session by then.
    stop: async ({ force }) => {
      logger.info("[start-codex] stop requested from web", { force: force ?? false });
      requestExit();
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
    await Promise.race([waitForExit(), exitRequested]);
    return 0;
  } finally {
    await remote.stop();
    rpcHandle.stop();
    sessionClient.stop();
    outbox.dispose();
  }
}
