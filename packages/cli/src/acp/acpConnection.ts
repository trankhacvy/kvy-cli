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

// fs stays unset (not advertised at all); terminal is explicit false for clarity.
const ACP_CLIENT_CAPABILITIES: ClientCapabilities = {
  terminal: false,
};

const MAX_STDERR_LINES = 20;
const MAX_BUFFERED_SESSION_UPDATES = 500;
// Prevents an untrusted adapter process from sending an unbounded _meta payload.
// Byte-size check only — not a deep structural walker.
const META_MAX_BYTES = 16 * 1024;

export type AcpConnectionState = "idle" | "connecting" | "ready" | "closed";

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface AcpConnectionOptions {
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
  /**
   * Injectable for tests; defaults to `node:child_process`'s `spawn`. The spawn spec's
   * `command` is always `process.execPath` (a plain `node <entry>` invocation, never a
   * shell command), so no cross-spawn shim is needed here.
   */
  spawn?: SpawnFn;
  /** Injectable for tests; defaults to `process.execPath`. */
  execPath?: string;
  /**
   * Injectable for tests; defaults to the real adapter-manager `installAdapter`.
   * Only ever invoked when `resolveSpawn` reports `reason: "not-installed"`.
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

/** Thrown for connect failures, adapter-unavailable refusals, and unexpected post-ready closes. Always carries the ring-buffered stderr tail. */
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
 * `_meta` bounds check — drops (never throws on) anything that isn't a plausibly-small
 * plain object, logging once per call site. `undefined`/`null` pass through unchanged.
 *
 * Exported so tests can exercise the "not a plain object" and "unserializable" drop paths
 * directly — both are unreachable end-to-end through a real adapter: `_meta` only arrives
 * already round-tripped through `JSON.parse`, and the SDK's own zod schemas default a
 * non-record `_meta` to `undefined` before `boundMeta` is ever called.
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
 * Handler seam for `session/request_permission`. The default (no handler set)
 * auto-cancels; callers must always settle a request one way or another.
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
   * The first subscriber receives any notifications buffered since `connect()` before
   * starting to receive live ones. Returns an unsubscribe function.
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

  /** Fires on unexpected post-ready adapter exit/connection close. Always carries the stderr tail. */
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

    // Auto-install only for "not-installed" — the clean first-run case where the adapter
    // was simply never installed. The other failure reasons are deliberately left to fail loudly:
    //   - "version-mismatch": the manifest was bumped; `kvy adapters upgrade` is the intended path.
    //     Silently reinstalling would mask a real upgrade event behind an opaque connect failure.
    //   - "integrity-mismatch": installed bytes don't match the pinned hash — silently
    //     reinstalling would paper over a signal that something doesn't match what Kvy shipped,
    //     defeating the purpose of the check.
    //   - "entry-missing": treated as a mismatch rather than auto-remediated, to keep
    //     this auto-install path narrow and easy to reason about.
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

  /** Exactly one `session/prompt` in-flight per session — throws if the previous call for this `sessionId` hasn't settled yet. */
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

  /** Aborts the in-flight prompt's cancellation signal (cooperative — the agent's response still settles the `prompt()` promise) and sends `session/cancel`. */
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
