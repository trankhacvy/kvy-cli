#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttentionKind,
  startHookServer,
  writeHookSettingsFile,
} from "../src/claude/hookServer.js";
import { getProjectPath, INTERNAL_CLAUDE_EVENT_TYPES } from "../src/claude/scanner.js";
import { type RawJSONLines, RawJSONLinesSchema } from "../src/claude/types.js";
import { FIXTURE_PROMPTS } from "./provider-contract/fixtures.js";

/** Thrown for any assumption about the provider's behavior that no longer holds. */
class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractViolation";
  }
}

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ContractViolation(message);
}

// Mirrors claude/claudeLocal.ts's own SESSION_ID_UUID_PATTERN — Claude Code
// 2.0.65+ requires a UUID-shaped session id for `--resume` to work.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_TURN_TIMEOUT_MS = 180_000;

function checkClaudeInstalled(): string {
  try {
    return execFileSync("claude", ["--version"], { encoding: "utf-8" }).trim();
  } catch (error) {
    throw new ContractViolation(
      `"claude" is not on PATH. This script only runs where the daily contract-test job just ` +
        `installed it (npm i -g @anthropic-ai/claude-code); a missing binary here is a real CI ` +
        `misconfiguration, not an expected local-dev gap. Underlying error: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface TurnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Spawns one non-interactive `claude -p` turn and resolves once it exits (or is killed on timeout). */
function runClaudeTurn(opts: {
  workingDirectory: string;
  hookSettingsPath: string;
  prompt: string;
  resumeSessionId?: string;
  timeoutMs: number;
}): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    const args = ["-p", opts.prompt, "--settings", opts.hookSettingsPath];
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);

    const child = spawn("claude", args, {
      cwd: opts.workingDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new ContractViolation(
          `claude did not exit within ${opts.timeoutMs}ms for prompt ${JSON.stringify(opts.prompt)} ` +
            `(resumeSessionId=${opts.resumeSessionId ?? "none"}). stdout tail: ${stdout.slice(-500)} ` +
            `stderr tail: ${stderr.slice(-500)}`,
        ),
      );
    }, opts.timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, signal, stdout, stderr });
    });
  });
}

/**
 * Reads and validates a session transcript file against exactly the same
 * schema and internal-event skip-list `claude/scanner.ts` uses, so this
 * check fails the moment scanner.ts's own real-world parsing would start
 * silently dropping/mis-keying lines.
 */
function readAndValidateTranscript(projectDir: string, sessionId: string): RawJSONLines[] {
  const file = join(projectDir, `${sessionId}.jsonl`);
  let contents: string;
  try {
    contents = readFileSync(file, "utf-8");
  } catch (error) {
    throw new ContractViolation(
      `expected transcript file not found at ${file} — Claude Code no longer writes a per-session ` +
        `JSONL transcript at the path claude/scanner.ts's getProjectPath() derives. Underlying error: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const lines = contents.split("\n").filter((line) => line.trim() !== "");
  assertContract(lines.length > 0, `transcript file ${file} exists but has no non-empty lines`);

  const entries: RawJSONLines[] = [];
  lines.forEach((line, index) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new ContractViolation(
        `transcript ${file}, line ${index}: not valid JSON — a JSONL tailer cannot recover from this. ` +
          `Content: ${line.slice(0, 200)}. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const type = (raw as { type?: unknown })?.type;
    if (typeof type === "string" && INTERNAL_CLAUDE_EVENT_TYPES.has(type)) return;

    const parsed = RawJSONLinesSchema.safeParse(raw);
    assertContract(
      parsed.success,
      `transcript ${file}, line ${index} (type=${String(type)}) no longer matches ` +
        `claude/types.ts's RawJSONLinesSchema — this is exactly the shape claude/scanner.ts depends on ` +
        `to derive dedup keys. Zod error: ${parsed.success ? "" : parsed.error.message}`,
    );
    entries.push(parsed.data);
  });

  const conversational = entries.filter(
    (entry) => entry.type === "user" || entry.type === "assistant",
  );
  assertContract(
    conversational.length > 0,
    `transcript ${file} parsed cleanly but contained no user/assistant entries`,
  );

  return entries;
}

async function main(): Promise<void> {
  const version = checkClaudeInstalled();
  console.log(`[provider-contract] claude --version: ${version}`);

  const timeoutMs = process.env.KVY_PROVIDER_CONTRACT_TIMEOUT_MS
    ? Number(process.env.KVY_PROVIDER_CONTRACT_TIMEOUT_MS)
    : DEFAULT_TURN_TIMEOUT_MS;

  const workingDirectory = mkdtempSync(join(tmpdir(), "kvy-provider-contract-"));
  const hookDir = join(workingDirectory, ".kvy-hooks");

  let currentTurn = -1;
  const sessionIdEvents: { turn: number; sessionId: string }[] = [];
  const attentionEvents: { turn: number; kind: AttentionKind }[] = [];

  const hookServer = await startHookServer({
    onSessionId: (sessionId) => {
      sessionIdEvents.push({ turn: currentTurn, sessionId });
    },
    onAttention: (kind) => {
      attentionEvents.push({ turn: currentTurn, kind });
    },
  });
  const hookSettings = writeHookSettingsFile(hookDir, hookServer.port);

  try {
    let priorSessionId: string | null = null;

    for (let index = 0; index < FIXTURE_PROMPTS.length; index += 1) {
      const fixture = FIXTURE_PROMPTS[index];
      assertContract(fixture, `no fixture at index ${index}`);
      currentTurn = index;
      const resumeSessionId = fixture.resumeFrom ? (priorSessionId ?? undefined) : undefined;
      if (fixture.resumeFrom) {
        assertContract(
          priorSessionId,
          `fixture "${fixture.name}" is marked resumeFrom but no prior turn produced a session id`,
        );
      }

      console.log(
        `[provider-contract] turn ${index} (${fixture.name}): spawning claude` +
          `${resumeSessionId ? ` --resume ${resumeSessionId}` : ""}...`,
      );

      const result = await runClaudeTurn({
        workingDirectory,
        hookSettingsPath: hookSettings.path,
        prompt: fixture.prompt,
        resumeSessionId,
        timeoutMs,
      });

      if (result.exitCode !== 0) {
        console.error(`[provider-contract] turn ${index} stdout:\n${result.stdout}`);
        console.error(`[provider-contract] turn ${index} stderr:\n${result.stderr}`);
      }
      assertContract(
        result.exitCode === 0 && result.signal === null,
        `turn ${index} (${fixture.name}): claude exited with code=${result.exitCode} signal=${result.signal}`,
      );

      const turnSessionEvents = sessionIdEvents.filter((event) => event.turn === index);
      assertContract(
        turnSessionEvents.length >= 1,
        `turn ${index} (${fixture.name}): the SessionStart hook never fired — Kvy's hook-based ` +
          `session-id discovery (claude/hookServer.ts) depends on this firing at least once per turn`,
      );
      const sessionId = turnSessionEvents[turnSessionEvents.length - 1]?.sessionId;
      assertContract(sessionId, `turn ${index}: SessionStart fired without a usable session id`);
      assertContract(
        UUID_PATTERN.test(sessionId),
        `turn ${index}: SessionStart hook fired with a non-UUID session_id (${sessionId})`,
      );

      if (resumeSessionId) {
        assertContract(
          sessionId === priorSessionId,
          `turn ${index} (${fixture.name}): "claude --resume ${priorSessionId}" reported a different ` +
            `SessionStart session_id (${sessionId}) — claude/claudeLocal.ts's --resume handling assumes ` +
            `resume continues under the same provider session id`,
        );
      }
      priorSessionId = sessionId;

      const turnAttention = attentionEvents.filter((event) => event.turn === index);
      assertContract(
        turnAttention.some((event) => event.kind === "done"),
        `turn ${index} (${fixture.name}): the Stop hook never fired "done" — Kvy's local-mode ` +
          `attention signal (claude/hookServer.ts) depends on this firing once the turn completes`,
      );

      const projectDir = getProjectPath(workingDirectory);
      const entries = readAndValidateTranscript(projectDir, sessionId);
      console.log(
        `[provider-contract] turn ${index} (${fixture.name}): OK — ${entries.length} valid transcript ` +
          `entries, session ${sessionId}`,
      );
    }

    console.log(`[provider-contract] all ${FIXTURE_PROMPTS.length} fixture turn(s) passed`);
  } finally {
    hookSettings.cleanup();
    await hookServer.stop();
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const kind = error instanceof ContractViolation ? "CONTRACT VIOLATION" : "ERROR";
  console.error(
    `[provider-contract] ${kind}: ${error instanceof Error ? error.message : String(error)}`,
  );
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
});
