/**
 * Port-scan primitive backing the `preview.ports` machine RPC (docs/features/
 * dev-server-preview.md): enumerate every listening TCP port currently
 * visible to this OS user via `lsof -nP -iTCP -sTCP:LISTEN`.
 *
 * Same hand-wrapped-`execFile`, resolve-`""`-on-any-failure convention as
 * `processScan.ts`'s `runPs`/`listProcesses` (10MB maxBuffer, never throws —
 * a scan that can't run is "found nothing", not a crash). macOS/Linux only —
 * `lsof` may also simply be absent on a minimal Linux install, which resolves
 * the same honest empty list rather than an error (matching
 * `processScan.ts`'s own platform-support caveat).
 *
 * **Scope**: this lists every listening socket on the whole machine, not
 * just the current session/workspace's own dev servers — Omnara's own "14
 * ports detected" copy is machine-wide too (docs/features/
 * dev-server-preview.md's "Port detection scope" decision). No
 * attribution/filtering to a particular workspace's process tree is applied
 * in the MVP.
 */
import { execFile } from "node:child_process";
import type { PreviewPortInfo } from "@kvy/wire";

const LSOF_ARGS = ["-nP", "-iTCP", "-sTCP:LISTEN"];

export interface PortScanDeps {
  /** Injectable for tests; defaults to a real `lsof` invocation. Resolves `""` on any failure (missing binary, non-zero exit, ...) rather than throwing/rejecting. */
  runLsof?: (args: string[]) => Promise<string>;
}

function defaultRunLsof(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("lsof", args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve("");
        return;
      }
      resolve(stdout.toString());
    });
  });
}

/**
 * Parses an `lsof -nP -iTCP -sTCP:LISTEN` transcript into one row per
 * distinct `(port, pid)` pair — a process listening on both the IPv4 and
 * IPv6 wildcard address for the same port (a very common pattern) yields a
 * single row, not two. Tolerates both macOS's and Linux's slightly different
 * `lsof` column layouts by anchoring on the two ends of each line (the
 * leading `COMMAND`/`PID` columns, the trailing `address:port (LISTEN)`
 * columns) rather than a fixed column count, and skips the header row and
 * any line that doesn't end in `(LISTEN)` or whose address:port token
 * doesn't parse — a malformed/unexpected line is dropped, never thrown.
 */
export function parseLsofOutput(output: string): PreviewPortInfo[] {
  const rows: PreviewPortInfo[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (!/\(LISTEN\)\s*$/i.test(line)) continue; // header row + any non-LISTEN line

    const tokens = line.split(/\s+/);
    if (tokens.length < 4) continue;

    const processName = tokens[0];
    const pidToken = tokens[1];
    const pid = pidToken !== undefined ? Number(pidToken) : Number.NaN;
    if (!processName || !Number.isFinite(pid)) continue; // header row's PID column is literally "PID"

    // The NAME column is always the last two whitespace-separated tokens:
    // `<address>:<port>` followed by `(LISTEN)`.
    const nameToken = tokens[tokens.length - 2];
    if (!nameToken) continue;
    const match = /^(.+):(\d+)$/.exec(nameToken);
    if (!match) continue;
    const address = match[1];
    const portToken = match[2];
    if (address === undefined || portToken === undefined) continue;
    const port = Number(portToken);
    if (!Number.isFinite(port)) continue;

    const dedupeKey = `${port}:${pid}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    rows.push({ port, address, pid, processName });
  }

  return rows.sort((a, b) => a.port - b.port);
}

/** Lists every listening TCP port visible to `lsof`, sorted by port ascending. Best-effort: resolves `[]` rather than throwing when `lsof` is unavailable or fails. */
export async function listListeningPorts(deps: PortScanDeps = {}): Promise<PreviewPortInfo[]> {
  const runLsof = deps.runLsof ?? defaultRunLsof;
  const output = await runLsof(LSOF_ARGS);
  return parseLsofOutput(output);
}
