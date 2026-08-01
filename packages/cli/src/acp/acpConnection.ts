/**
 * ACP transport core (design §7.3 "single `AcpRemote`", §7.4 "Remote mode
 * (v0.3 — ACP)", §7.9 "adapter manager", §7.10; plan.md §16 "17. v2 — ACP
 * migration / Phase 2.1 — ACP core").
 *
 * Spawns the managed ACP adapter child (resolved through the already-landed
 * adapter manager's verify-before-spawn seam, `../adapters/spawn.ts` —
 * never `node_modules` paths touched directly, never `npx`) and drives it
 * via `@agentclientprotocol/sdk`'s `client()` builder over NDJSON stdio.
 * Provider-agnostic on purpose: the only Claude/Codex-specific pieces (the
 * `_meta.systemPrompt`/`_meta.claudeCode.options.resume` payload Claude
 * needs at `session/new`, wiring this into `claudeRemoteLauncher.ts`, and
 * the ACP → `SessionEnvelope` mapper) are later Phase 2.1/2.2 tasks — this
 * module only owns the transport: connect, session lifecycle, prompt/cancel/
 * set_mode, and the permission-request handler seam.
 *
 * Ported (adapted, P) from mobvibe's `apps/mobvibe-cli/src/acp/
 * acp-connection.ts` (Apache-2.0) — same overall shape (spawn → `client()`
 * builder → `initialize` → session lifecycle → prompt/cancel), but with its
 * `fs`/`terminal` client-capability handlers dropped entirely (design:
 * "client capabilities (no fs, no terminal initially)") and its deep
 * recursive `_meta` payload sanitizer (`sanitizeAcpMessageMeta`/
 * `sanitizeAcpMeta`, a full bounded JSON-clone walker) replaced by a single
 * cheap byte-size bounds check (`boundMeta` below) — the load-bearing
 * "don't let a misbehaving adapter hand us an unbounded blob" property,
 * without the walker's depth/key/array-shape breadth.
 *
 * Two additions beyond mobvibe's own shape, both called out explicitly by
 * plan.md's task description:
 *  - **Exactly one `session/prompt` in flight per session**: `prompt()`
 *    throws if a previous call for the same `sessionId` hasn't settled yet,
 *    rather than mobvibe's `Set<AbortController>` (which tolerates several
 *    concurrent turns per session — ACP only allows one).
 *  - **Pre-ready session-update buffering**: the SDK's own
 *    `onNotification(session.update, ...)` handler is wired before any
 *    session is created (structurally guaranteed by the `client()` builder
 *    requiring every handler before `.connect()`), but `session/update`
 *    notifications can still arrive before *this class's own caller* has
 *    had a chance to call `onSessionUpdate()` (e.g. between `createSession()`
 *    resolving and the caller's next tick). Updates are buffered until the
 *    first `onSessionUpdate()` subscriber attaches, then flushed in order
 *    and delivered live from then on — see `emitSessionUpdate`/
 *    `onSessionUpdate` below.
 */
import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  type AgentCapabilities,
  type ClientCapabilities,
  type ClientConnection,
  type ContentBlock,
  client,
  type Implementation,
  type JsonRpcId,
  type LoadSessionResponse,
  methods,
  type NewSessionResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  AdapterId,
  AdapterInstallOutcome,
  ResolveAdapterSpawnResult,
} from "../adapters/index.js";
import { installAdapter, resolveAdapterSpawn } from "../adapters/index.js";
import type { Logger } from "../logger.js";

/** Design: "initialize handshake declaring client capabilities (no fs, no terminal initially)". `fs` stays unset (no filesystem capability advertised at all); `terminal` is explicit `false` for clarity. */
const ACP_CLIENT_CAPABILITIES: ClientCapabilities = {
  terminal: false,
};

const MAX_STDERR_LINES = 20;
const MAX_BUFFERED_SESSION_UPDATES = 500;
/** Cheap bound on inbound `_meta` payloads (design intent: never let an untrusted adapter process hand this transport an unbounded blob). Deliberately just a serialized byte-size check — see file header for what was dropped from mobvibe's much deeper sanitizer. */
const META_MAX_BYTES = 16 * 1024;

export type AcpConnectionState = "idle" | "connecting" | "ready" | "closed";

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface AcpConnectionOptions {
  /** Which managed adapter to spawn — resolved via `resolveAdapterSpawn` (design §7.9). */
  adapterId: AdapterId;
  /** `~/.kvy` (or override) — passed straight through to `resolveAdapterSpawn`. */
  homeDir: string;
  clientInfo: { name: string; version: string };
  /** Extra env vars merged onto `process.env` for the spawned adapter. */
  envOverrides?: Record<string, string>;
  logger?: Logger;
}

export interface AcpConnectionDeps {
  /** Injectable for tests; defaults to the real adapter-manager `resolveAdapterSpawn`. */
  resolveSpawn?: (
    id: AdapterId,
    homeDir: string,
    execPath?: string,
  ) => Promise<ResolveAdapterSpawnResult>;
  /** Injectable for tests; defaults to `node:child_process`'s `spawn`. The adapter manager's spawn spec's `command` is always `process.execPath` (a plain `node <entry>` invocation, never a shell command), so no `cross-spawn` shim resolution is needed here. */
  spawn?: SpawnFn;
  /** Injectable for tests; defaults to `process.execPath`. */
  execPath?: string;
  /**
   * Injectable for tests; defaults to the real adapter-manager `installAdapter`
   * (A2 — auto-install fallback, design §7.9). Only ever invoked when
   * `resolveSpawn` reports `reason: "not-installed"` — see `connect()`'s doc
   * comment for why the other verify-failure reasons are deliberately NOT
   * auto-remediated here.
   */
  installAdapter?: (
    id: AdapterId,
    deps: { homeDir: string },
    opts?: { force?: boolean },
  ) => Promise<AdapterInstallOutcome>;
}

export type SessionUpdateListener = (notification: SessionNotification) => void;

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Thrown/emitted for connect failures, adapter-unavailable refusals, and unexpected post-ready closes — always carries the ring-buffered stderr tail (design §7.4: "Adapter stderr is ring-buffered and attached to connect/exit errors so spawn failures surface legibly"). */
export class AcpConnectionError extends Error {
  readonly stderrTail?: string;

  constructor(message: string, stderrTail?: string) {
    super(stderrTail ? `${message}\nAdapter stderr:\n${stderrTail}` : message);
    this.name = "AcpConnectionError";
    this.stderrTail = stderrTail;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatExitMessage(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `ACP adapter process received signal ${signal}`;
  if (code !== null) return `ACP adapter process exited with code ${code}`;
  return "ACP adapter process exited";
}

function hasPipedStdio(child: ChildProcess): child is ChildProcessWithoutNullStreams {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}

/**
 * Cheap `_meta` bounds check (file header) — drops (never throws on) anything that isn't a
 * plausibly-small plain object, logging once per call site. `undefined`/`null` pass through
 * unchanged since both are valid "no metadata" per the ACP schema.
 *
 * Exported (only) so `acpConnection.test.ts` can exercise the "not a plain object" and
 * "unserializable" drop paths directly — neither is reachable end-to-end through a real
 * spawned adapter: the "unserializable" path needs a value that fails `JSON.stringify` (a
 * circular reference, a `BigInt`), and `_meta` here only ever arrives already round-tripped
 * through `JSON.parse`, which can't produce either. The "not a plain object" path needs a
 * non-record `_meta` (e.g. an array) to reach this function at all, but
 * `@agentclientprotocol/sdk`'s own generated zod schemas already validate every `_meta` field
 * as `z.record(z.string(), z.unknown()).nullish()` and default a non-conforming value to
 * `undefined` *before* `emitSessionUpdate`/`handlePermissionRequest` ever call `boundMeta` —
 * so both branches are real defensive code for future non-wire-sourced callers, verified by a
 * direct unit test rather than an integration one.
 */
export function boundMeta(
  meta: unknown,
  logger: Logger,
  context: string,
): Record<string, unknown> | null | undefined {
  if (meta === undefined) return undefined;
  if (meta === null) return null;
  if (typeof meta !== "object" || Array.isArray(meta)) {
    logger.warn("[acp-connection] dropping malformed _meta (not a plain object)", { context });
    return null;
  }
  let sizeBytes: number;
  try {
    const serialized = JSON.stringify(meta);
    sizeBytes =
      serialized === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(serialized, "utf8");
  } catch {
    logger.warn("[acp-connection] dropping unserializable _meta", { context });
    return null;
  }
  if (sizeBytes > META_MAX_BYTES) {
    logger.warn("[acp-connection] dropping oversized _meta", {
      context,
      sizeBytes,
      maxBytes: META_MAX_BYTES,
    });
    return null;
  }
  return meta as Record<string, unknown>;
}

/**
 * Handler seam for `session/request_permission` (design §7.6: "to be wired
 * to the existing permission pipeline by a later task"). Returning
 * `undefined` leaves the request unanswered forever — callers must always
 * settle it one way or another; the default (no handler set) auto-cancels.
 */
export type PermissionRequestHandler = (
  params: RequestPermissionRequest,
  requestId: JsonRpcId,
  signal: AbortSignal,
) => Promise<RequestPermissionResponse>;

export class AcpConnection {
  private state: AcpConnectionState = "idle";
  private connection?: ClientConnection;
  private process?: ChildProcessWithoutNullStreams;
  private disconnecting = false;

  private agentInfo?: Implementation;
  private agentCapabilities?: AgentCapabilities;

  private recentStderr: string[] = [];

  private readonly promptControllers = new Map<string, AbortController>();

  private readonly sessionUpdateListeners = new Set<SessionUpdateListener>();
  private bufferedSessionUpdates: SessionNotification[] = [];
  private hasSessionUpdateSubscriber = false;

  private readonly errorListeners = new Set<(error: AcpConnectionError) => void>();

  private permissionHandler?: PermissionRequestHandler;

  private readonly logger: Logger;

  constructor(
    private readonly options: AcpConnectionOptions,
    private readonly deps: AcpConnectionDeps = {},
  ) {
    this.logger = options.logger ?? noopLogger;
  }

  getState(): AcpConnectionState {
    return this.state;
  }

  getAgentInfo(): Implementation | undefined {
    return this.agentInfo;
  }

  getAgentCapabilities(): AgentCapabilities | undefined {
    return this.agentCapabilities;
  }

  supportsSessionLoad(): boolean {
    return this.agentCapabilities?.loadSession === true;
  }

  supportsSessionResume(): boolean {
    return this.agentCapabilities?.sessionCapabilities?.resume != null;
  }

  setPermissionHandler(handler: PermissionRequestHandler | undefined): void {
    this.permissionHandler = handler;
  }

  /**
   * Subscribes to `session/update` notifications. The first subscriber
   * receives any notifications buffered since `connect()` (pre-ready
   * buffering — see file header) before starting to receive live ones.
   * Returns an unsubscribe function.
   */
  onSessionUpdate(listener: SessionUpdateListener): () => void {
    if (!this.hasSessionUpdateSubscriber) {
      this.hasSessionUpdateSubscriber = true;
      for (const buffered of this.bufferedSessionUpdates) listener(buffered);
      this.bufferedSessionUpdates = [];
    }
    this.sessionUpdateListeners.add(listener);
    return () => this.sessionUpdateListeners.delete(listener);
  }

  /** Fires on connect failure surfaced asynchronously (n/a — `connect()` rejects directly) and on unexpected post-ready adapter exit/connection close. Always carries the stderr tail. */
  onError(listener: (error: AcpConnectionError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.state === "connecting" || this.state === "ready") return;

    this.state = "connecting";
    this.disconnecting = false;
    this.recentStderr = [];
    this.agentInfo = undefined;
    this.agentCapabilities = undefined;

    const resolveSpawn = this.deps.resolveSpawn ?? resolveAdapterSpawn;
    const execPath = this.deps.execPath ?? process.execPath;
    const logger = this.logger;
    let spawnResult = await resolveSpawn(this.options.adapterId, this.options.homeDir, execPath);

    // A2 (design §7.9): a daemon-initiated spawn used to report "started"
    // (via the notify self-report `start.ts`/`startCodex.ts` fire right
    // after `bootstrapSession()`) long before this connect() ever ran — the
    // ACP connection only opens later inside `runRemoteLoop()`. If the
    // adapter was simply never installed (the clean, common first-run case —
    // `kvy adapters install` was never run and no prior spawn attempt
    // installed it either), a web user would see a session that looked live
    // and then silently broke. Auto-install once, here, so the first
    // daemon-initiated spawn just works.
    //
    // Deliberately scoped to ONLY `reason === "not-installed"`. The other
    // verify-failure reasons are left alone and still fail loudly:
    //   - "version-mismatch": the manifest was bumped since the last
    //     install. Silently reinstalling here would mask a real upgrade
    //     event behind an opaque connect failure/retry; the explicit
    //     `kvy adapters upgrade` path exists precisely so a version
    //     change is a visible, intentional action, not something that
    //     happens invisibly on a background daemon spawn.
    //   - "integrity-mismatch": the installed bytes don't match the pinned
    //     hash — this is exactly the "corrupted/tampered/downgraded
    //     install" case `verify.ts`'s own doc comment calls out as real,
    //     load-bearing verification. Auto-reinstalling over it would
    //     silently paper over a signal that something on disk doesn't match
    //     what Kvy shipped a hash for, which defeats the point of having
    //     the check at all — this must surface to a human (or `kvy
    //     doctor`), not be quietly "fixed".
    //   - "entry-missing": lock says the right version+integrity is present
    //     but the spawn entrypoint file itself is gone (e.g. a partially
    //     deleted `node_modules`). This is arguably as safe to
    //     auto-remediate as "not-installed", but it's a rare enough state
    //     (and cheap enough to diagnose via `kvy doctor`/`adapters
    //     install`) that treating it the same as a real mismatch — fail
    //     loudly rather than silently reinstall — was chosen to keep this
    //     auto-install path narrow and easy to reason about.
    if (!spawnResult.ok && spawnResult.reason === "not-installed") {
      logger.info(
        `[acp-connection] adapter "${this.options.adapterId}" is not installed — auto-installing before spawn`,
      );
      const doInstallAdapter = this.deps.installAdapter ?? installAdapter;
      const installOutcome = await doInstallAdapter(this.options.adapterId, {
        homeDir: this.options.homeDir,
      });
      if (!installOutcome.ok) {
        this.state = "closed";
        throw new AcpConnectionError(
          `ACP adapter "${this.options.adapterId}" is not installed and auto-install failed: ${installOutcome.error}`,
        );
      }
      logger.info(
        `[acp-connection] auto-installed adapter "${this.options.adapterId}" (${installOutcome.status}, v${installOutcome.version})`,
      );
      spawnResult = await resolveSpawn(this.options.adapterId, this.options.homeDir, execPath);
    }

    if (!spawnResult.ok) {
      this.state = "closed";
      throw new AcpConnectionError(
        `ACP adapter "${this.options.adapterId}" is not usable (${spawnResult.reason})${
          spawnResult.detail ? `: ${spawnResult.detail}` : ""
        }`,
      );
    }

    const spawnImpl = this.deps.spawn ?? nodeSpawn;
    const env = this.options.envOverrides
      ? { ...process.env, ...this.options.envOverrides }
      : process.env;
    const child = spawnImpl(spawnResult.spec.command, spawnResult.spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    if (!hasPipedStdio(child)) {
      child.kill("SIGTERM");
      this.state = "closed";
      throw new AcpConnectionError("ACP adapter child process did not provide piped stdio");
    }

    this.process = child;

    child.stderr.on("data", (chunk: Buffer) => {
      if (this.process !== child) return;
      this.recordStderr(chunk.toString("utf8"));
    });

    child.once("exit", (code, signal) => {
      this.handleUnexpectedClose(child, formatExitMessage(code, signal));
    });
    child.once("error", (error) => {
      this.handleUnexpectedClose(child, getErrorMessage(error));
    });

    let connection: ClientConnection | undefined;
    try {
      const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
      const output = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
      const stream = ndJsonStream(input, output);

      const app = client({ name: this.options.clientInfo.name })
        .onRequest(methods.client.session.requestPermission, ({ params, requestId, signal }) =>
          this.handlePermissionRequest(params, requestId, signal),
        )
        .onNotification(methods.client.session.update, ({ params }) =>
          this.emitSessionUpdate(params),
        );

      connection = app.connect(stream);
      this.connection = connection;

      connection.closed.then(() => this.handleUnexpectedClose(child, "ACP connection closed"));

      const initializeResponse = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: ACP_CLIENT_CAPABILITIES,
        clientInfo: {
          name: this.options.clientInfo.name,
          version: this.options.clientInfo.version,
        },
      });

      this.agentInfo = initializeResponse.agentInfo ?? undefined;
      this.agentCapabilities = initializeResponse.agentCapabilities ?? undefined;
      this.state = "ready";
    } catch (error) {
      const stderrTail = this.getStderrTail();
      this.state = "closed";
      connection?.close(error);
      this.connection = undefined;
      if (this.process === child) this.process = undefined;
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      throw new AcpConnectionError(
        `Failed to connect to ACP adapter: ${getErrorMessage(error)}`,
        stderrTail,
      );
    }
  }

  async createSession(options: {
    cwd: string;
    additionalDirectories?: readonly string[];
    meta?: Record<string, unknown> | null;
  }): Promise<NewSessionResponse> {
    const connection = this.requireReady();
    return connection.agent.request(methods.agent.session.new, {
      cwd: options.cwd,
      mcpServers: [],
      additionalDirectories:
        options.additionalDirectories && options.additionalDirectories.length > 0
          ? [...options.additionalDirectories]
          : undefined,
      _meta: options.meta ?? undefined,
    });
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    additionalDirectories?: readonly string[],
    meta?: Record<string, unknown> | null,
  ): Promise<LoadSessionResponse> {
    const connection = this.requireReady();
    if (!this.supportsSessionLoad()) {
      throw new Error("ACP agent does not support session/load");
    }
    return connection.agent.request(methods.agent.session.load, {
      sessionId,
      cwd,
      mcpServers: [],
      additionalDirectories:
        additionalDirectories && additionalDirectories.length > 0
          ? [...additionalDirectories]
          : undefined,
      _meta: meta ?? undefined,
    });
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    additionalDirectories?: readonly string[],
    meta?: Record<string, unknown> | null,
  ): Promise<ResumeSessionResponse> {
    const connection = this.requireReady();
    if (!this.supportsSessionResume()) {
      throw new Error("ACP agent does not support session/resume");
    }
    return connection.agent.request(methods.agent.session.resume, {
      sessionId,
      cwd,
      mcpServers: [],
      additionalDirectories:
        additionalDirectories && additionalDirectories.length > 0
          ? [...additionalDirectories]
          : undefined,
      _meta: meta ?? undefined,
    });
  }

  /** Exactly one `session/prompt` in flight per session (design/plan.md) — throws if the previous call for this `sessionId` hasn't settled yet. The request's `cancellationSignal` is wired to `cancel()`'s abort below. */
  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    const connection = this.requireReady();
    if (this.promptControllers.has(sessionId)) {
      throw new Error(`A session/prompt is already in flight for session "${sessionId}"`);
    }
    const controller = new AbortController();
    this.promptControllers.set(sessionId, controller);
    try {
      return await connection.agent.request(
        methods.agent.session.prompt,
        { sessionId, prompt },
        { cancellationSignal: controller.signal },
      );
    } finally {
      this.promptControllers.delete(sessionId);
    }
  }

  /** Aborts the in-flight prompt's cancellation signal (if any — cooperative, the agent's eventual response still settles the `prompt()` promise) and sends the protocol-level `session/cancel` notification. */
  async cancel(sessionId: string): Promise<void> {
    const connection = this.requireReady();
    this.promptControllers.get(sessionId)?.abort(new Error("Prompt cancelled by Kvy client"));
    await connection.agent.notify(methods.agent.session.cancel, { sessionId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const connection = this.requireReady();
    await connection.agent.request(methods.agent.session.setMode, { sessionId, modeId });
  }

  async disconnect(): Promise<void> {
    if (this.state === "closed" && !this.process) return;
    this.disconnecting = true;
    this.state = "closed";

    for (const controller of this.promptControllers.values()) {
      controller.abort(new Error("ACP connection closed"));
    }
    this.promptControllers.clear();

    this.connection?.close();
    this.connection = undefined;

    const child = this.process;
    this.process = undefined;
    if (child && child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  }

  private requireReady(): ClientConnection {
    if (this.state !== "ready" || !this.connection) {
      throw new Error("ACP connection is not ready, call connect() first");
    }
    return this.connection;
  }

  private recordStderr(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.recentStderr.push(trimmed);
      if (this.recentStderr.length > MAX_STDERR_LINES) this.recentStderr.shift();
    }
  }

  private getStderrTail(): string | undefined {
    return this.recentStderr.length > 0 ? this.recentStderr.join("\n") : undefined;
  }

  private emitSessionUpdate(notification: SessionNotification): void {
    const sanitized: SessionNotification = {
      ...notification,
      _meta: boundMeta(notification._meta, this.logger, "session/update"),
    };
    if (!this.hasSessionUpdateSubscriber) {
      this.bufferedSessionUpdates.push(sanitized);
      if (this.bufferedSessionUpdates.length > MAX_BUFFERED_SESSION_UPDATES) {
        this.bufferedSessionUpdates.shift();
        this.logger.warn("[acp-connection] pre-ready session-update buffer overflowed", {
          maxBuffered: MAX_BUFFERED_SESSION_UPDATES,
        });
      }
      return;
    }
    for (const listener of this.sessionUpdateListeners) listener(sanitized);
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest,
    requestId: JsonRpcId,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const sanitized: RequestPermissionRequest = {
      ...params,
      _meta: boundMeta(params._meta, this.logger, "session/request_permission"),
    };
    if (!this.permissionHandler) {
      return { outcome: { outcome: "cancelled" } };
    }
    return this.permissionHandler(sanitized, requestId, signal);
  }

  private handleUnexpectedClose(child: ChildProcess, detail: string): void {
    if (this.process !== child || this.disconnecting || this.state !== "ready") return;
    this.state = "closed";
    const stderrTail = this.getStderrTail();
    this.process = undefined;
    this.connection = undefined;
    for (const controller of this.promptControllers.values()) {
      controller.abort(new Error(detail));
    }
    this.promptControllers.clear();
    for (const listener of this.errorListeners) {
      listener(new AcpConnectionError(detail, stderrTail));
    }
  }
}
