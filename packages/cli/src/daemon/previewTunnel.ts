/**
 * Daemon-side core for the `preview.ports`/`preview.tunnels`/`preview.open`/
 * `preview.close` machine RPCs (docs/features/dev-server-preview.md). This
 * is the one genuinely new long-lived-child-process subsystem the feature
 * needs — everything else follows the established RPC-handler pattern.
 *
 * `handlePreviewOpen` spawns `cloudflared tunnel --url http://localhost:
 * <port> --no-autoupdate`, journals the pid immediately (before a URL has
 * even been parsed — `tunnelRegistry.ts`'s `appendJournalEntry`, so a crash
 * in that exact window still leaves a trail `reapOrphanedTunnels` can find
 * at the next boot), tracks it in the in-memory registry with `status:
 * 'starting'`, and scans its stderr line-by-line for the first
 * `https://<subdomain>.trycloudflare.com` match — cloudflared's quick-tunnel
 * URL always appears on stderr, not stdout. On success the tracked tunnel
 * flips to `status: 'active'` with its real `url`. On timeout or the child
 * exiting before a URL ever appeared, the child is killed (best-effort) and
 * the attempt rejects carrying the tail of a bounded stderr ring buffer
 * (mirrors `acp/acpConnection.ts`'s own stderr-ring-buffer-on-error idea) —
 * `cloudflared`'s stderr format is not a stable, documented API, so a
 * release that changes it shows up here as a plain timeout/exit failure,
 * not a silent parse bug.
 *
 * A permanent `child.once('exit', ...)` listener removes the tunnel from
 * both the live registry and the durable journal whenever `cloudflared`
 * dies for ANY reason — a clean `preview.close`, a crash hours into an
 * otherwise-successful tunnel, or a pre-URL failure — so the registry never
 * holds a stale entry for a process that's actually gone.
 *
 * `handlePreviewOpen` is per-port idempotent at the SEQUENTIAL level: a
 * second call for a port that already has a tracked tunnel (from an earlier,
 * already-settled call) returns that tunnel's existing result instead of
 * spawning a duplicate. TRUE concurrency (two `preview.open` calls for the
 * same port racing in flight) is a different guard, layered on top by
 * `machineRpc.ts`'s `withPortGuard` (a structural clone of that module's own
 * `withProviderSessionGuard`) — this module has no in-flight-request
 * deduplication of its own.
 *
 * `handlePreviewClose` signals the tracked child directly (its own known
 * pid — no `processScan.ts`/`markers.ts` discovery involved, unlike
 * `kill.ts`'s targets), SIGTERM-then-wait(`gracefulTimeoutMs`, default
 * 5s)-then-SIGKILL, same escalation timing as `kill.ts`/`adoptTake.ts`.
 * Closing an already-closed (or never-existent) tunnelId is a no-op
 * `{ok:true}` — idempotent by construction, same as `fs.mkdir`.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type {
  PreviewCloseParams,
  PreviewCloseResult,
  PreviewOpenParams,
  PreviewOpenResult,
  PreviewPortInfo,
  PreviewPortsParams,
  PreviewPortsResult,
  PreviewTunnelsParams,
  PreviewTunnelsResult,
} from "@falcon/wire";
import { createId } from "@paralleldrive/cuid2";
import crossSpawnDefault from "cross-spawn";
import type { Logger } from "../logger.js";
import type { CloudflaredDetection } from "./cloudflaredResolve.js";
import { detectCloudflared as detectCloudflaredDefault } from "./cloudflaredResolve.js";
import { createKillDeps, type KillSignal } from "./kill.js";
import { listListeningPorts as listListeningPortsDefault } from "./portScan.js";
import { appendJournalEntry, removeJournalEntry, type TunnelRegistry } from "./tunnelRegistry.js";

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface PreviewTunnelDeps {
  homeDir: string;
  /** The single, shared, per-daemon-process tunnel registry (`tunnelRegistry.ts`'s `createTunnelRegistry()`). */
  registry: TunnelRegistry;
  /** Injectable for tests; defaults to a real `cross-spawn` invocation of `cloudflared`. */
  spawnImpl?: SpawnFn;
  /** Injectable for tests; defaults to `cloudflaredResolve.ts`'s real detection. */
  detectCloudflared?: () => Promise<CloudflaredDetection>;
  /** Injectable for tests; defaults to `portScan.ts`'s real `lsof`-backed scan. */
  listListeningPorts?: () => Promise<PreviewPortInfo[]>;
  killPid?: (pid: number, signal: KillSignal) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Injectable for tests; defaults to `@paralleldrive/cuid2`'s `createId`. */
  createId?: () => string;
  /** Refuses to open a new tunnel once this many are already tracked. Default 5 — a small, deliberate cap (docs/features/dev-server-preview.md's security posture note). */
  maxTunnels?: number;
  /** How long `handlePreviewOpen` waits for a `*.trycloudflare.com` URL to appear on stderr before giving up and killing the child. Default 30s. */
  urlTimeoutMs?: number;
  /** SIGTERM-then-SIGKILL grace period for `handlePreviewClose`. Default 5s, matching `kill.ts`/`adoptTake.ts`. */
  gracefulTimeoutMs?: number;
  logger?: Logger;
}

const DEFAULT_MAX_TUNNELS = 5;
const DEFAULT_URL_TIMEOUT_MS = 30_000;
const DEFAULT_GRACEFUL_TIMEOUT_MS = 5000;
const STDERR_RING_LIMIT = 20;
const TRYCLOUDFLARE_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Fills in real OS-backed defaults for anything not overridden — same shape/convention as `createAdoptTakeDeps`/`createKillDeps`. */
export function createPreviewTunnelDeps(
  required: Pick<PreviewTunnelDeps, "homeDir" | "registry">,
  overrides: Partial<PreviewTunnelDeps> = {},
): PreviewTunnelDeps {
  const killDeps = createKillDeps();
  return {
    spawnImpl: crossSpawnDefault as unknown as SpawnFn,
    detectCloudflared: () => detectCloudflaredDefault(),
    listListeningPorts: () => listListeningPortsDefault(),
    killPid: killDeps.killPid,
    isAlive: killDeps.isAlive,
    sleep: killDeps.sleep,
    now: killDeps.now,
    createId,
    maxTunnels: DEFAULT_MAX_TUNNELS,
    urlTimeoutMs: DEFAULT_URL_TIMEOUT_MS,
    gracefulTimeoutMs: DEFAULT_GRACEFUL_TIMEOUT_MS,
    ...required,
    ...overrides,
  };
}

/** `preview.ports` — the machine's listening TCP ports plus whether `cloudflared` itself is installed. */
export async function handlePreviewPorts(
  _params: PreviewPortsParams,
  deps: PreviewTunnelDeps,
): Promise<PreviewPortsResult> {
  const detectCloudflared = deps.detectCloudflared ?? detectCloudflaredDefault;
  const listListeningPorts = deps.listListeningPorts ?? listListeningPortsDefault;

  const [ports, cloudflared] = await Promise.all([listListeningPorts(), detectCloudflared()]);

  return {
    cloudflared: {
      installed: cloudflared.installed,
      ...(cloudflared.version !== undefined ? { version: cloudflared.version } : {}),
    },
    ports,
  };
}

/** `preview.tunnels` — every currently tracked tunnel, in the wire shape (the registry's own `child` handle stripped out). */
export async function handlePreviewTunnels(
  _params: PreviewTunnelsParams,
  deps: PreviewTunnelDeps,
): Promise<PreviewTunnelsResult> {
  return {
    tunnels: deps.registry.list().map((tunnel) => ({
      tunnelId: tunnel.tunnelId,
      port: tunnel.port,
      url: tunnel.url,
      status: tunnel.status,
      startedAt: tunnel.startedAt,
    })),
  };
}

function pushStderrLines(ring: string[], chunk: string): void {
  for (const line of chunk.split("\n")) {
    if (line.trim() === "") continue;
    ring.push(line);
    if (ring.length > STDERR_RING_LIMIT) ring.shift();
  }
}

function stderrTailSuffix(ring: string[]): string {
  return ring.length > 0 ? ` (cloudflared stderr tail:\n${ring.join("\n")})` : "";
}

/**
 * `preview.open` — spawns (or reuses) a `cloudflared` quick tunnel for
 * `params.port`. See this module's own header comment for the full
 * lifecycle. Throws (any `Error`) on failure — `machineRpc.ts` forwards the
 * message as-is (`cloudflared-not-installed`, `max-tunnels-reached`, a
 * timeout/exit message with a stderr tail, or a raw spawn error).
 */
export async function handlePreviewOpen(
  params: PreviewOpenParams,
  deps: PreviewTunnelDeps,
): Promise<PreviewOpenResult> {
  const logger = deps.logger ?? noopLogger;
  const detectCloudflared = deps.detectCloudflared ?? detectCloudflaredDefault;
  const spawnImpl = deps.spawnImpl ?? (crossSpawnDefault as unknown as SpawnFn);
  const now = deps.now ?? Date.now;
  const mintId = deps.createId ?? createId;
  const maxTunnels = deps.maxTunnels ?? DEFAULT_MAX_TUNNELS;
  const urlTimeoutMs = deps.urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS;

  const detection = await detectCloudflared();
  if (!detection.installed) {
    throw new Error("cloudflared-not-installed");
  }

  // Sequential per-port idempotency: a tunnel already tracked for this port
  // (from an earlier, already-settled `preview.open`) is handed back as-is
  // rather than spawning a second `cloudflared` child. True in-flight
  // concurrency is `machineRpc.ts`'s `withPortGuard`'s job, not this
  // function's — see this module's header comment.
  const existing = deps.registry.getByPort(params.port);
  if (existing) {
    return { tunnelId: existing.tunnelId, url: existing.url, port: existing.port };
  }

  if (deps.registry.list().length >= maxTunnels) {
    throw new Error("max-tunnels-reached");
  }

  const child = spawnImpl(
    "cloudflared",
    ["tunnel", "--url", `http://localhost:${params.port}`, "--no-autoupdate"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const rawPid = child.pid;
  if (typeof rawPid !== "number") {
    throw new Error("failed to spawn cloudflared: no pid was assigned");
  }
  // Re-bound to a fresh `const` so its `number` narrowing survives capture
  // by the closures below (TS doesn't always retain a narrowed type across
  // nested function-declaration boundaries for the original binding).
  const pid: number = rawPid;

  const tunnelId = mintId();
  const startedAt = now();
  const stderrRing: string[] = [];

  deps.registry.add({
    tunnelId,
    port: params.port,
    url: "",
    pid,
    startedAt,
    status: "starting",
    child,
  });
  // Journaled immediately, before the URL has even appeared — a crash in
  // this exact window must still leave a trail for `reapOrphanedTunnels`.
  // Deliberately NOT awaited here: attaching the stderr/exit/error
  // listeners below must happen synchronously, in the same tick as the
  // spawn, or a fast-talking real `cloudflared` (or a test double) could
  // emit its URL before anything is listening for it. `finalizeSuccess`
  // below awaits this same promise before resolving, so callers still never
  // observe a resolved `preview.open` whose journal entry isn't written yet.
  const journalWritten = appendJournalEntry(deps.homeDir, { pid, port: params.port, startedAt });

  return new Promise<PreviewOpenResult>((resolve, reject) => {
    let settled = false;

    async function finalizeSuccess(url: string): Promise<void> {
      await journalWritten.catch(() => {});
      const tracked = deps.registry.get(tunnelId);
      if (tracked) {
        tracked.url = url;
        tracked.status = "active";
      }
      logger.info("[preview-tunnel] tunnel active", { port: params.port, url, tunnelId });
      resolve({ tunnelId, url, port: params.port });
    }

    async function finalizeFailure(error: Error): Promise<void> {
      deps.registry.remove(tunnelId);
      await removeJournalEntry(deps.homeDir, pid).catch(() => {});
      reject(error);
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.warn("[preview-tunnel] timed out waiting for a tunnel URL", {
        port: params.port,
        pid,
      });
      child.kill?.("SIGKILL");
      void finalizeFailure(
        new Error(
          `timed out waiting for cloudflared to report a tunnel URL${stderrTailSuffix(stderrRing)}`,
        ),
      );
    }, urlTimeoutMs);

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      pushStderrLines(stderrRing, text);
      if (settled) return;

      const match = TRYCLOUDFLARE_URL_PATTERN.exec(stderrRing.join("\n"));
      if (!match) return;

      settled = true;
      clearTimeout(timer);
      void finalizeSuccess(match[0]);
    });

    // Self-cleanup (this module's header comment): whenever this exact
    // child exits, for ANY reason, its tunnel is gone — drop it from both
    // the live registry and the durable journal, whether that's a clean
    // `preview.close`, a spontaneous crash long after success, or a
    // pre-URL failure. Only reject the in-flight open promise for the
    // last case (`!settled`) — a post-success exit has nothing left to
    // settle, just clean up.
    child.once("exit", (code) => {
      if (settled) {
        deps.registry.remove(tunnelId);
        void removeJournalEntry(deps.homeDir, pid);
        return;
      }
      settled = true;
      clearTimeout(timer);
      void finalizeFailure(
        new Error(
          `cloudflared exited (code ${code ?? "unknown"}) before a tunnel URL appeared${stderrTailSuffix(stderrRing)}`,
        ),
      );
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void finalizeFailure(new Error(`failed to spawn cloudflared: ${error.message}`));
    });
  });
}

/** `preview.close` — idempotent: closing an already-closed (or never tracked) `tunnelId` is a no-op `{ok:true}`, same contract as `fs.mkdir`. */
export async function handlePreviewClose(
  params: PreviewCloseParams,
  deps: PreviewTunnelDeps,
): Promise<PreviewCloseResult> {
  const logger = deps.logger ?? noopLogger;
  const tunnel = deps.registry.get(params.tunnelId);
  if (!tunnel) {
    return { ok: true };
  }

  const killPid = deps.killPid ?? createKillDeps().killPid;
  const isAlive = deps.isAlive ?? createKillDeps().isAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const gracefulTimeoutMs = deps.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;

  killPid(tunnel.pid, "SIGTERM");
  logger.info("[preview-tunnel] SIGTERM sent to tunnel child", {
    tunnelId: tunnel.tunnelId,
    pid: tunnel.pid,
  });

  const deadline = now() + gracefulTimeoutMs;
  while (isAlive(tunnel.pid) && now() < deadline) {
    await sleep(200);
  }
  if (isAlive(tunnel.pid)) {
    killPid(tunnel.pid, "SIGKILL");
    logger.warn("[preview-tunnel] tunnel child ignored SIGTERM, sent SIGKILL", {
      tunnelId: tunnel.tunnelId,
      pid: tunnel.pid,
    });
  }

  // Belt-and-suspenders: `handlePreviewOpen`'s own `exit` listener normally
  // does this already once the signal actually lands, but removing it here
  // too keeps `preview.close` correct even if that event hasn't fired yet by
  // the time this returns.
  deps.registry.remove(tunnel.tunnelId);
  await removeJournalEntry(deps.homeDir, tunnel.pid);

  return { ok: true };
}

/** Closes every currently tracked tunnel in parallel — the daemon shutdown path (`machineIntegration.ts`'s `stop()`). */
export async function closeAllTunnels(deps: PreviewTunnelDeps): Promise<void> {
  const tunnels = deps.registry.list();
  await Promise.all(
    tunnels.map((tunnel) =>
      handlePreviewClose({ idempotencyKey: "shutdown", tunnelId: tunnel.tunnelId }, deps),
    ),
  );
}
