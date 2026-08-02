/**
 * claude`'s local↔remote mode loop (`commands/start.ts`) — a Codex session is
 * **remote from the start**: it drives one `AcpRemote` on the `codex-acp`
 * adapter for its whole lifetime, with no `loop()` and no local child.
 *
 * ## Two entry shapes
 *
 * **Daemon-spawned (`--started-by daemon`, the web wizard's New Session →
 * Codex flow via `daemon/spawnEngine.ts`):** the full remote host below —
 * bootstrap → outbox → session-scoped WS + the five session RPCs → the
 * send-idempotency claim store — running headless, ending only on Ctrl-C/
 * web `stop`.
 *
 * **Terminal run (a human typing `kvy codex`):** there is nothing a
 * foreground process adds that the web session can't do better — no TUI to
 * type into, no take-back to hand control back to — so this command stops
 * being a session host here. It keeps the honest pieces a terminal run is
 * actually good for (Codex CLI detection + pairing via `runPreflightWithReauth`)
 * and, on success, prints `codexDashboardGuidance` (open your dashboard,
 * start the session there) and exits 0 — no bootstrap, no ACP child, no
 * "waiting for Ctrl-C" dead end.
 *
 * The full-flow scaffolding below (bootstrap/outbox/WS/RPCs) is the same a
 * `kvy claude` session uses, just without the mode machinery: the
 * `message`/`interrupt`/`setMode`/`perm.answer` RPCs route straight into the
 * `AcpRemoteHandle`. `takeControl` has no meaning here (there is no local
 * terminal to hand control back to) and answers an honest `{ok:false}`.
 *
 * exec/patch approvals arrive through ACP's standard
 * `session/request_permission` → the same `AcpPermissionHandler` Claude uses
 */
import path from "node:path";
import { encodeBase64, wrapDek } from "@kvy/crypto";
import { createId } from "@paralleldrive/cuid2";
import { startAcpRemote as startAcpRemoteDefault } from "../acp/acpRemote.js";
import { createHttpClient } from "../api/httpClient.js";
import { Outbox } from "../api/outbox.js";
import { resolveBackendUrl, resolveFrontendUrl } from "../auth/config.js";
import {
  type KvyCredentials,
  readCredentials as readCredentialsDefault,
} from "../auth/credentials.js";
import { ensureLoggedIn as ensureLoggedInDefault } from "../auth/login.js";
import { claimMessageSend, completeMessageSend } from "../claims/claimStore.js";
import {
  CODEX_NO_LOCAL_MODE_NOTE,
  type DetectCodexOptions,
  detectCodex as detectCodexDefault,
  type ProviderDetectionResult,
} from "../codex/index.js";
import {
  createNotifyDaemonSessionStartedDeps,
  notifyDaemonSessionStarted as notifyDaemonSessionStartedDefault,
  reportSessionStartFailed as reportSessionStartFailedDefault,
} from "../daemon/notify.js";
import { reloadDaemonAuth as reloadDaemonAuthDefault } from "../daemon/reloadAuth.js";
import { type DaemonState, readDaemonState as readDaemonStateDefault } from "../daemon/state.js";
import type { Logger } from "../logger.js";
import { registerSessionRpcHandlers, type SessionRpcHandlers } from "../rpc/sessionRpc.js";
import { announceRemoteControl } from "../session/announceRemoteControl.js";
import {
  bootstrapSession as bootstrapSessionDefault,
  createBootstrapSessionDeps,
} from "../session/bootstrap.js";
import { extractContinueFromFlag } from "../session/continueFromFlag.js";
import { extractModelFlag } from "../session/modelFlag.js";
import { registerSessionWorkspace } from "../session/registerSessionWorkspace.js";
import {
  createSessionClientDeps,
  startSessionClient as startSessionClientDefault,
} from "../session/sessionClient.js";
import { codexDashboardGuidance, NO_TTY_CANNOT_SIGN_IN } from "../ui/messages.js";
import type { registerWorkspace as registerWorkspaceDefault } from "../workspace/registry.js";
import { runPreflightWithReauth } from "./startPreflight.js";

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
  /** Injectable for tests; defaults to the real `resolveFrontendUrl(env)`. */
  frontendUrl?: string;
  readCredentials?: (homeDir: string) => KvyCredentials | null;
  readDaemonState?: (homeDir: string) => Promise<DaemonState | null>;
  fetchImpl?: typeof fetch;
  detectCodex?: (options?: DetectCodexOptions) => Promise<ProviderDetectionResult>;
  bootstrapSession?: typeof bootstrapSessionDefault;
  registerWorkspace?: typeof registerWorkspaceDefault;
  /**
   * Injectable for tests; defaults to the real `notifyDaemonSessionStarted()`
   * (`daemon/notify.ts` — best-effort, never throws). Mirrors `start.ts`'s
   * self-report: without this, a daemon-initiated `spawn` RPC's
   * `spawnAwaiter` (`daemon/spawnAwaiter.ts`) never learns this Codex session
   * actually started and unconditionally times out after
   * `DEFAULT_SPAWN_AWAITER_TIMEOUT_MS` (15s), regardless of whether Codex
   * itself started fine.
   */
  notifyDaemonSessionStarted?: typeof notifyDaemonSessionStartedDefault;
  /**
   * Injectable for tests; defaults to the real `reportSessionStartFailed()`
   * (A4, `daemon/notify.ts` — best-effort, never throws). Mirrors
   * `start.ts`'s same self-report on a `bootstrapSession()` failure.
   */
  reportSessionStartFailed?: typeof reportSessionStartFailedDefault;
  startAcpRemote?: typeof startAcpRemoteDefault;
  startSessionClient?: typeof startSessionClientDefault;
  registerSessionRpcHandlers?: typeof registerSessionRpcHandlers;
  /**
   * Resolves when the session should end (Ctrl-C at the terminal). Injectable
   * so tests drive the lifetime without a real signal; defaults to a
   * one-shot `SIGINT` listener.
   */
  waitForExit?: () => Promise<void>;
  ensureLoggedIn?: typeof ensureLoggedInDefault;
  reloadDaemonAuth?: (homeDir: string) => Promise<boolean>;
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

/** True only for headless spawns (`spawnEngine`/`resumeSession`/`adopt` all
 * pass `--started-by daemon`) — a human's `kvy codex` never carries it. */
function isDaemonSpawn(args: string[]): boolean {
  const index = args.indexOf("--started-by");
  return index !== -1 && args[index + 1] === "daemon";
}

/** Runs `kvy codex [args...]`. Returns the process exit code. */
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
  const doNotifyDaemonSessionStarted =
    deps.notifyDaemonSessionStarted ?? notifyDaemonSessionStartedDefault;
  const doReportSessionStartFailed =
    deps.reportSessionStartFailed ?? reportSessionStartFailedDefault;
  const startAcpRemote = deps.startAcpRemote ?? startAcpRemoteDefault;
  const startSessionClient = deps.startSessionClient ?? startSessionClientDefault;
  const registerRpc = deps.registerSessionRpcHandlers ?? registerSessionRpcHandlers;
  const waitForExit = deps.waitForExit ?? waitForSigint;

  // 1. Fail honestly if the Codex CLI (its `app-server` the adapter drives)
  // isn't installed.
  const detection = await detect();
  if (!detection.installed) {
    writeError(`kvy codex: ${detection.error ?? "Codex CLI is not installed."}\n`);
    return 1;
  }

  const backendUrl = deps.backendUrl ?? resolveBackendUrl(env);

  // 2. Credentials, key material, machineId and an access token as one restartable
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
    model: extractModelFlag(deps.codexArgs),
  };

  const workspaceId = await registerSessionWorkspace(deps.workingDirectory, {
    registerWorkspace: deps.registerWorkspace,
    logger,
  });

  // Terminal run (no `--started-by daemon`): pairing + workspace registration
  // are this command's real job — there is no TUI for a foreground session to
  // add, so guide the user to the dashboard and exit instead of blocking on
  // Ctrl-C forever (see the file header's "Two entry shapes").
  if (!isDaemonSpawn(deps.codexArgs)) {
    const frontendUrl = deps.frontendUrl ?? resolveFrontendUrl(env);
    write(codexDashboardGuidance(frontendUrl));
    return 0;
  }

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
        provider: "codex",
        contentKeyPair,
        metadata: sessionMetadata,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[start-codex] bootstrapSession failed", { message });
    writeError(`kvy codex: failed to start session: ${message}\n`);
    // A4: same best-effort self-report as `start.ts` — lets a daemon-
    // initiated spawn's `spawnAwaiter` reject with the real error instead
    // of a generic timeout.
    const reportResult = await doReportSessionStartFailed(
      createNotifyDaemonSessionStartedDeps({ homeDir: deps.homeDir, fetchImpl, logger }),
      { error: message },
    );
    logger.debug("[start-codex] daemon self-report (start failed)", { reportResult });
    return 1;
  }

  // A1 (docs/known-issues.md — Codex daemon-spawn timeout): mirror
  // `start.ts`'s post-`bootstrapSession()` self-report to the daemon
  // (`daemon/notify.ts` — best-effort, never throws, so an absent/unreachable
  // daemon never blocks session startup). Without this, a daemon-initiated
  // `spawn` RPC's `spawnAwaiter.waitFor()` has nothing to resolve it and
  // unconditionally times out after `DEFAULT_SPAWN_AWAITER_TIMEOUT_MS`
  // (15s) — every daemon-spawned Codex session used to fail this way
  // regardless of whether Codex itself started successfully.
  const notifyResult = await doNotifyDaemonSessionStarted(
    createNotifyDaemonSessionStartedDeps({ homeDir: deps.homeDir, fetchImpl, logger }),
    {
      sessionId: bootstrap.sessionId,
      metadata: sessionMetadata,
      encryption: {
        encryptionKey: encodeBase64(wrapDek(bootstrap.dek, contentKeyPair.publicKey)),
        seq: 0,
        metadataVersion: 0,
        agentStateVersion: 0,
      },
    },
  );
  logger.debug("[start-codex] daemon self-report", {
    sessionId: bootstrap.sessionId,
    notifyResult,
  });

  // Re-notify the daemon once the real ACP provider session id is known
  // (`startAcpRemote`'s `onProviderSessionId`, below) — mirrors `start.ts`'s
  // `notifyDaemonProviderSessionId`. Without this, `providerSessionId` never
  // has nothing to resume: the id this session ran under would be lost the
  // moment the process exits.
  function notifyDaemonProviderSessionId(providerSessionId: string): void {
    void doNotifyDaemonSessionStarted(
      createNotifyDaemonSessionStartedDeps({ homeDir: deps.homeDir, fetchImpl, logger }),
      {
        sessionId: bootstrap.sessionId,
        metadata: { ...sessionMetadata, providerSessionId },
        encryption: {
          encryptionKey: encodeBase64(wrapDek(bootstrap.dek, contentKeyPair.publicKey)),
          seq: 0,
          metadataVersion: 0,
          agentStateVersion: 0,
        },
      },
    ).then((result) => {
      logger.debug("[start-codex] daemon self-report (provider session id)", {
        sessionId: bootstrap.sessionId,
        providerSessionId,
        result,
      });
    });
  }

  write(`kvy codex: starting session ${bootstrap.sessionId}\n${CODEX_NO_LOCAL_MODE_NOTE}\n`);

  const outbox = new Outbox({
    sessionId: bootstrap.sessionId,
    dek: bootstrap.dek,
    http: createHttpClient({
      serverUrl: backendUrl,
      // issue #1 (docs/known-issues-cliweb-sync-test.md): same fix as start.ts's Outbox —
      // pull a currently-valid token from the shared `TokenProvider` on every
      // request/retry instead of the `accessToken` string captured once at preflight.
      getAuthToken: () => tokenProvider.getAccessToken(),
      onUnauthorized: () => tokenProvider.forceRefresh(),
      fetchImpl,
    }),
    homeDir: deps.homeDir,
    logger,
  });

  const sessionClient = startSessionClient(
    createSessionClientDeps(
      { serverUrl: backendUrl, tokenProvider, sessionId: bootstrap.sessionId },
      { logger },
    ),
  );

  // envelopeId -> claimId, so the turn-settle hook completes exactly the
  const openClaims = new Map<string, string>();

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
    resume: extractContinueFromFlag(deps.codexArgs),
    permissionMode: "default",
    homeDir: deps.homeDir,
    onEnvelopes: (envelopes) => outbox.enqueue(envelopes),
    onProviderSessionId: (providerSessionId) => notifyDaemonProviderSessionId(providerSessionId),
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

  outbox.enqueue([announceRemoteControl()]);

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
    // docs/known-issues.md issue #12's web model selector is PTY-only
    // (`start.ts`'s `runLocalPty`) — Codex has no live terminal to type
    // ACP has no analogous model-change call. Honest not-supported.
    setModel: () => {
      logger.debug("[start-codex] setModel RPC — Codex has no PTY to inject a model switch into");
      return { ok: false };
    },
    // honest not-supported rather than a fake success.
    takeControl: () => {
      logger.debug("[start-codex] takeControl RPC — Codex has no local mode to return to");
      return { ok: false };
    },
    permAnswer: ({ reqId, decision }) => remote.resolvePermission({ reqId, decision }),
    // Same not-yet-landed status-reporting caveat as `start.ts`'s `stop`
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
