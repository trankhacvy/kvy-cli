/**
 * `falcon doctor` (+ `falcon doctor clean`) — process discovery,
 * categorization, and runaway-process cleanup. Ported, with changes, from
 * Happy's `daemon/doctor.ts` (https://github.com/slopus/happy, MIT); plan.md
 * §16 "3.2 Durability": "`falcon doctor` (+ `clean`): process discovery,
 * categorization, runaway kill".
 *
 * `falcon doctor` is purely diagnostic: it reports every Falcon-owned
 * process currently visible to `ps` (via `processScan.ts` + `markers.ts`'s
 * classifier — the exact same discovery mechanism `kill.ts` uses, so this
 * never depends on `daemon.state.json`/the control server being reachable
 * either), plus the locally-recorded daemon state and how many sessions are
 * resumable from `sessions.json`. It never sends a signal to anything.
 *
 * It also reports ACP adapter health and provider CLI detection (design
 * §7.9: "`falcon doctor` reports adapter presence/version/integrity and the
 * underlying provider CLI detection (`claude` binary, `codex` binary)") —
 * `checkAllAdaptersHealth` (`../adapters/health.ts`) re-verifies every
 * pinned adapter's install against `ADAPTER_MANIFEST`, and
 * `detectClaudeCode`/`detectCodex` (the same `ProviderAdapter.detect()`
 * implementations `falcon claude`/`falcon codex` themselves use) report
 * whether the underlying provider CLI is even findable.
 *
 * `falcon doctor clean` is the destructive half: it targets **runaway**
 * processes — every daemon-classified process (`kind: "daemon"`) plus every
 * daemon-*spawned* session (`kind: "session"` with `spawnedByDaemon: true`)
 * — and kills them SIGTERM-then-SIGKILL, reusing `kill.ts`'s exact
 * escalation logic (`killGraceful`). Deliberately narrower than `falcon kill
 * all`: a session the user started directly from a terminal is not
 * "runaway" just because a daemon happens to be running too, so plain
 * terminal sessions (`spawnedByDaemon: false`) are left alone — `falcon
 * kill sessions`/`all` remain the blunter, "kill everything" escape hatches
 * for that case.
 */
import { type AdapterHealth, checkAllAdaptersHealth } from "../adapters/health.js";
import { detectCodex } from "../codex/codexProviderAdapter.js";
import type { Logger } from "../logger.js";
import {
  detectClaudeCode,
  type ProviderDetectionResult,
} from "../provider/claudeProviderAdapter.js";
import { createKillDeps, type KillDeps, type KillOutcome, killGraceful } from "./kill.js";
import { isProcessAlive } from "./lock.js";
import { type ClassifiedProcess, classifyProcesses } from "./markers.js";
import { listProcesses, type ProcessEntry } from "./processScan.js";
import { readPersistedSessions } from "./sessionsStore.js";
import { type DaemonState, readDaemonState } from "./state.js";

export interface DoctorDaemonSummary {
  running: boolean;
  pid?: number;
  port?: number;
  version?: string;
}

export interface DoctorProviderSummary {
  claude: ProviderDetectionResult;
  codex: ProviderDetectionResult;
}

export interface DoctorReport {
  daemon: DoctorDaemonSummary;
  resumableSessionCount: number;
  processes: ClassifiedProcess[];
  adapters: AdapterHealth[];
  providers: DoctorProviderSummary;
}

export interface DoctorDeps {
  homeDir: string;
  listProcesses: () => Promise<ProcessEntry[]>;
  isProcessAlive: (pid: number) => boolean;
  currentPid: number;
  /** Defaults to `checkAllAdaptersHealth` — injectable so tests never touch a real `~/.falcon/adapters` install. */
  checkAdapters?: (homeDir: string) => Promise<AdapterHealth[]>;
  /** Defaults to `detectClaudeCode` — injectable so tests never shell out to a real `claude` on PATH. */
  detectClaudeProvider?: () => Promise<ProviderDetectionResult>;
  /** Defaults to `detectCodex` — injectable so tests never shell out to a real `codex` on PATH. */
  detectCodexProvider?: () => Promise<ProviderDetectionResult>;
  logger?: Logger;
}

export function createDoctorDeps(overrides: Partial<DoctorDeps> & { homeDir: string }): DoctorDeps {
  return {
    listProcesses,
    isProcessAlive,
    currentPid: process.pid,
    checkAdapters: checkAllAdaptersHealth,
    detectClaudeProvider: detectClaudeCode,
    detectCodexProvider: detectCodex,
    ...overrides,
  };
}

function summarizeDaemon(state: DaemonState | null, alive: boolean): DoctorDaemonSummary {
  if (!state || !alive) return { running: false };
  return { running: true, pid: state.pid, port: state.port, version: state.version };
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checkAdapters = deps.checkAdapters ?? checkAllAdaptersHealth;
  const detectClaudeProvider = deps.detectClaudeProvider ?? detectClaudeCode;
  const detectCodexProvider = deps.detectCodexProvider ?? detectCodex;

  const [state, persisted, rawProcesses, adapters, claude, codex] = await Promise.all([
    readDaemonState(deps.homeDir),
    readPersistedSessions(deps.homeDir),
    deps.listProcesses(),
    checkAdapters(deps.homeDir),
    detectClaudeProvider(),
    detectCodexProvider(),
  ]);

  const processes = classifyProcesses(rawProcesses, deps.currentPid);
  const daemon = summarizeDaemon(state, state !== null && deps.isProcessAlive(state.pid));

  return {
    daemon,
    resumableSessionCount: Object.keys(persisted).length,
    processes,
    adapters,
    providers: { claude, codex },
  };
}

export function describeDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(
    report.daemon.running
      ? `daemon: running (pid ${report.daemon.pid}, port ${report.daemon.port}, version ${report.daemon.version})`
      : "daemon: not running",
  );
  lines.push(`resumable sessions (sessions.json): ${report.resumableSessionCount}`);
  lines.push("");

  if (report.processes.length === 0) {
    lines.push("no falcon-owned processes found");
  } else {
    lines.push(`falcon-owned processes (${report.processes.length}):`);
    for (const p of report.processes) {
      const marker = p.spawnedByDaemon ? " [daemon-spawned]" : "";
      lines.push(`  pid ${p.pid} [${p.kind}]${marker} — ${p.command}`);
    }
  }

  lines.push("");
  lines.push("ACP adapters:");
  for (const a of report.adapters) {
    const detail = a.detail ? ` (${a.detail})` : "";
    lines.push(`  ${a.id} — ${a.packageName}@${a.pinnedVersion}: ${a.status}${detail}`);
  }

  lines.push("");
  lines.push("provider CLIs:");
  lines.push(`  claude: ${describeProviderDetection(report.providers.claude)}`);
  lines.push(`  codex: ${describeProviderDetection(report.providers.codex)}`);

  return `${lines.join("\n")}\n`;
}

function describeProviderDetection(detection: ProviderDetectionResult): string {
  if (!detection.installed) return "not installed";
  const version = detection.version ? ` (version ${detection.version})` : "";
  return detection.authenticated ? `installed${version}` : `installed${version}, not authenticated`;
}

function isRunaway(p: ClassifiedProcess): boolean {
  return p.kind === "daemon" || (p.kind === "session" && p.spawnedByDaemon);
}

export interface DoctorCleanSummary {
  /** Runaway processes matched before any signal was sent. */
  targeted: ClassifiedProcess[];
  outcomes: KillOutcome[];
}

const DEFAULT_GRACEFUL_TIMEOUT_MS = 5000;

export async function runDoctorClean(
  deps: KillDeps = createKillDeps(),
  gracefulTimeoutMs = DEFAULT_GRACEFUL_TIMEOUT_MS,
): Promise<DoctorCleanSummary> {
  const processes = await deps.listProcesses();
  const targeted = classifyProcesses(processes, deps.currentPid).filter(isRunaway);
  return { targeted, outcomes: await killGraceful(targeted, deps, gracefulTimeoutMs) };
}

export function describeDoctorCleanSummary(summary: DoctorCleanSummary): string {
  if (summary.targeted.length === 0) {
    return "falcon doctor clean: no runaway processes found\n";
  }
  const succeeded = summary.outcomes.filter((o) => o.error === undefined).length;
  const lines = summary.outcomes.map((o) => {
    const status = o.error !== undefined ? `FAILED (${o.error})` : o.signal;
    return `  pid ${o.pid} [${o.kind}] ${status} — ${o.command}`;
  });
  return `falcon doctor clean: ${succeeded}/${summary.targeted.length} runaway process(es) terminated\n${lines.join("\n")}\n`;
}
