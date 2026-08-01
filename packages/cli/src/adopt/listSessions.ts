/**
 * Local (terminal-side) enumeration of plain Claude Code sessions for a
 * workspace directory — design §7.8's `listRecentSessions`: "enumerate
 * provider transcripts in cwd's workspace, preselect most recent." Backs
 * `kvy adopt [--list]` (plan.md §16 "3.3 Session adoption (UC9)").
 *
 * Purely local: no server round-trip. Reuses
 * `daemon/transcriptIndexer.ts`'s `parseTranscript` (title/last-activity
 * extraction) and `claude/scanner.ts`'s `getProjectPath` — the same
 * building blocks the daemon's ambient indexer uses, so a session listed
 * here always agrees with what the dashboard would eventually show for the
 * same workspace.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderSessionSummary } from "@kvy/wire";
import { getProjectPath } from "../claude/scanner.js";
import { parseTranscript } from "../daemon/transcriptIndexer.js";
import { createLivenessDeps, findOwningClaudeProcess, type LivenessDeps } from "./liveness.js";

const JSONL_EXT = ".jsonl";

export interface ListAdoptableSessionsOptions {
  workingDirectory: string;
  env?: NodeJS.ProcessEnv;
  liveness?: LivenessDeps;
}

/**
 * Lists every plain (unmanaged) Claude Code session transcript found for
 * `workingDirectory`, most-recently-active first. Empty (never throws) if
 * the project dir doesn't exist yet or holds no readable transcripts.
 */
export async function listAdoptableSessions(
  options: ListAdoptableSessionsOptions,
): Promise<ProviderSessionSummary[]> {
  const env = options.env ?? process.env;
  const liveness = options.liveness ?? createLivenessDeps();
  const projectDir = getProjectPath(options.workingDirectory, env);

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return [];
  }

  const summaries: ProviderSessionSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith(JSONL_EXT)) continue;
    const providerSessionId = name.slice(0, -JSONL_EXT.length);

    let contents: string;
    try {
      contents = await readFile(path.join(projectDir, name), "utf-8");
    } catch {
      continue;
    }

    const parsed = parseTranscript(contents);
    if (!parsed) continue;

    summaries.push({
      providerSessionId,
      title: parsed.title,
      lastActivityAt: parsed.lastActivity,
      running: false,
    });
  }

  const owning = await findOwningClaudeProcess(options.workingDirectory, projectDir, liveness);
  if (owning) {
    const match = summaries.find((s) => s.providerSessionId === owning.providerSessionId);
    if (match) match.running = true;
  }

  summaries.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return summaries;
}
