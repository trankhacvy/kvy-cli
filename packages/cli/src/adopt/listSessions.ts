/**
 * Purely local enumeration: no server round-trip. Reuses the same building
 * blocks as the daemon's ambient indexer, so sessions listed here always
 * agree with what the dashboard shows for the same workspace.
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
