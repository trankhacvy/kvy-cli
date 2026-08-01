/**
 * The receive side of the PTY-mode fetch signal (see
 * `kvy_claude_launcher.cjs`'s "PTY mode" note and `ptyClaudeSession.ts`).
 *
 * A PTY child has no spare fd 3, so the launcher's `fetch-start`/`fetch-end`
 * lines — the same instrumentation `claudeLocal.ts` reads off fd 3 for its
 * "thinking" indicator — are delivered over a unix-domain socket instead.
 * This module owns that socket: it binds an OS-local path, hands the path
 * back for `KVY_FETCH_SIGNAL_PATH`, parses newline-delimited JSON from the
 * launcher, and invokes `onEvent` for each well-formed fetch event.
 *
 * Best-effort by construction: a bind failure resolves with an empty `path`
 * (the caller then simply omits the env var and the idle signal degrades to
 * the injection cooldown) rather than throwing — a missing thinking-indicator
 * tick must never take down a live coding session.
 */

import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "../logger.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** One parsed fetch lifecycle event from the launcher. */
export interface FetchSignalEvent {
  type: "fetch-start" | "fetch-end";
  id: number;
}

export interface FetchSignalServer {
  /**
   * The socket path to advertise as `KVY_FETCH_SIGNAL_PATH`, or an empty
   * string when binding failed (idle detection then degrades gracefully).
   */
  path: string;
  /** Stop listening and remove the socket file. Safe to call once. */
  close(): Promise<void>;
}

export interface CreateFetchSignalServerOptions {
  homeDir: string;
  onEvent: (event: FetchSignalEvent) => void;
  logger?: Logger;
}

/** Builds an OS-appropriate, collision-resistant socket path. */
function makeSocketPath(): string {
  const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
  if (process.platform === "win32") {
    // Windows named pipe (unix-socket filesystem paths don't apply).
    return `\\\\.\\pipe\\kvy-fetch-${token}`;
  }
  // Keep well under the ~104-char sockaddr_un limit.
  return path.join(tmpdir(), `kvy-fetch-${token}.sock`);
}

function handleConnectionData(
  chunk: string,
  buffer: string,
  onEvent: (e: FetchSignalEvent) => void,
): string {
  let buf = buffer + chunk;
  for (;;) {
    const newlineIndex = buf.indexOf("\n");
    if (newlineIndex < 0) break;
    const line = buf.slice(0, newlineIndex);
    buf = buf.slice(newlineIndex + 1);
    if (line.trim() === "") continue;
    try {
      const message = JSON.parse(line) as { type?: unknown; id?: unknown };
      if (
        (message.type === "fetch-start" || message.type === "fetch-end") &&
        typeof message.id === "number"
      ) {
        onEvent({ type: message.type, id: message.id });
      }
    } catch {
      // A malformed line is ignored — the signal is advisory only.
    }
  }
  return buf;
}

/**
 * Start listening for the launcher's fetch signal. Resolves once bound (or,
 * on failure, with an empty `path`) — never rejects.
 */
export function createFetchSignalServer(
  opts: CreateFetchSignalServerOptions,
): Promise<FetchSignalServer> {
  const logger = opts.logger ?? noopLogger;
  const socketPath = makeSocketPath();

  return new Promise((resolve) => {
    // Track live connections so close() can force them shut — otherwise
    // `server.close()` hangs waiting on the launcher's still-open socket.
    const connections = new Set<Socket>();
    const server: Server = createServer((connection) => {
      connections.add(connection);
      connection.on("close", () => connections.delete(connection));
      connection.setEncoding("utf8");
      let buffer = "";
      connection.on("data", (chunk: string) => {
        buffer = handleConnectionData(chunk, buffer, opts.onEvent);
      });
      connection.on("error", () => {
        // A dropped launcher connection is not our problem to surface.
      });
    });

    const closeServer = async (): Promise<void> => {
      for (const connection of connections) connection.destroy();
      connections.clear();
      await new Promise<void>((done) => server.close(() => done()));
      if (process.platform !== "win32") {
        await unlink(socketPath).catch(() => {});
      }
    };

    server.on("error", (error) => {
      logger.debug("[pty-fetch-signal] bind failed — idle signal disabled for this session", {
        error: error instanceof Error ? error.message : String(error),
      });
      resolve({ path: "", close: async () => {} });
    });

    server.listen(socketPath, () => {
      logger.debug("[pty-fetch-signal] listening", { socketPath });
      resolve({ path: socketPath, close: closeServer });
    });
  });
}
