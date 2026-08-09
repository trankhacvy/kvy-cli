import { existsSync } from "node:fs";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "../logger.js";
import { createSessionScanner, getProjectPath, type SessionScanner } from "./scanner.js";
import type { RawJSONLines } from "./types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function userLine(uuid: string): string {
  return `${JSON.stringify({ type: "user", uuid })}\n`;
}

function summaryLine(leafUuid: string, summary: string): string {
  return `${JSON.stringify({ type: "summary", leafUuid, summary })}\n`;
}

function internalLine(type: string): string {
  return `${JSON.stringify({ type })}\n`;
}

function uuids(messages: RawJSONLines[]): string[] {
  return messages.map((m) => (m as { uuid: string }).uuid);
}

interface DebugRecord {
  message: string;
  meta?: Record<string, unknown>;
}

function collectingLogger(): {
  logger: Logger;
  debugRecords: DebugRecord[];
  infoRecords: DebugRecord[];
} {
  const debugRecords: DebugRecord[] = [];
  const infoRecords: DebugRecord[] = [];
  return {
    debugRecords,
    infoRecords,
    logger: {
      debug: (message, meta) => {
        debugRecords.push({ message, meta });
      },
      info: (message, meta) => {
        infoRecords.push({ message, meta });
      },
      warn: () => {},
      error: () => {},
    },
  };
}

describe("getProjectPath", () => {
  it("sanitizes the resolved working directory into a flat project id under CLAUDE_CONFIG_DIR", () => {
    const env = { CLAUDE_CONFIG_DIR: "/home/user/.claude" };
    const result = getProjectPath("/home/user/my project", env);
    expect(result).toBe(join("/home/user/.claude", "projects", "-home-user-my-project"));
  });

  it("falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset", () => {
    const result = getProjectPath("/tmp/proj", {});
    expect(result).toContain(join(".claude", "projects"));
  });
});

describe("createSessionScanner", () => {
  let baseDir: string;
  let claudeConfigDir: string;
  let workingDirectory: string;
  let projectDir: string;
  let env: NodeJS.ProcessEnv;
  let scanner: SessionScanner | null = null;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    baseDir = join(tmpdir(), `scanner-test-${unique}`);
    claudeConfigDir = join(baseDir, "claude-home");
    workingDirectory = join(baseDir, "project");
    env = { CLAUDE_CONFIG_DIR: claudeConfigDir };
    projectDir = getProjectPath(workingDirectory, env);
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    if (scanner) {
      await scanner.cleanup();
      scanner = null;
    }
    if (existsSync(baseDir)) {
      await rm(baseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("picks up incrementally appended entries exactly once, skipping pre-existing history", async () => {
    const seen: RawJSONLines[] = [];
    const file = join(projectDir, "sess-incremental.jsonl");
    await writeFile(file, userLine("u1"));

    scanner = await createSessionScanner({
      sessionId: "sess-incremental",
      workingDirectory,
      onMessage: (m) => seen.push(m),
      missingFileTimeoutMs: 100_000,
      pollIntervalMs: 60,
      env,
    });

    await sleep(150);
    // The entry present before the scanner started is existing history, not
    // a fresh message — it must not be emitted.
    expect(uuids(seen)).toEqual([]);

    await appendFile(file, userLine("u2"));
    await sleep(300);
    expect(uuids(seen)).toEqual(["u2"]);

    await appendFile(file, userLine("u3"));
    await appendFile(file, userLine("u4"));
    await sleep(300);
    expect(uuids(seen)).toEqual(["u2", "u3", "u4"]);

    // Further sync ticks with no new content must not re-emit anything.
    await sleep(300);
    expect(uuids(seen)).toEqual(["u2", "u3", "u4"]);
  });

  it("flush() ingests a just-appended entry synchronously, without waiting for the periodic poll", async () => {
    // Reproduces the live-confirmed race: a caller (Claude Code's `Stop`
    // hook, via `ptyClaudeSession.ts`'s `closeTurn`) can need to know the
    // transcript is fully ingested at an arbitrary moment, not on the poll's
    // own schedule. A long poll interval stands in for "the poll hasn't run
    // yet" — if flush() only waited for the periodic timer, this entry
    // would still be unseen when we check.
    const seen: RawJSONLines[] = [];
    const file = join(projectDir, "sess-flush.jsonl");
    await writeFile(file, userLine("u1"));

    scanner = await createSessionScanner({
      sessionId: "sess-flush",
      workingDirectory,
      onMessage: (m) => seen.push(m),
      missingFileTimeoutMs: 100_000,
      pollIntervalMs: 60_000, // long enough that it will not fire during this test
      env,
    });

    await appendFile(file, userLine("u2"));
    // No sleep for the poll interval — flush() must ingest it immediately.
    await scanner.flush();
    expect(uuids(seen)).toEqual(["u2"]);
  });

  it("dedupes across a simulated restart (fresh process, same transcript file)", async () => {
    const file = join(projectDir, "sess-restart.jsonl");
    await writeFile(file, userLine("u1") + userLine("u2"));

    const seenA: RawJSONLines[] = [];
    const scannerA = await createSessionScanner({
      sessionId: "sess-restart",
      workingDirectory,
      onMessage: (m) => seenA.push(m),
      missingFileTimeoutMs: 100_000,
      pollIntervalMs: 60,
      env,
    });
    await sleep(150);
    expect(seenA).toEqual([]); // pre-existing entries marked processed at construction

    await appendFile(file, userLine("u3"));
    await sleep(200);
    expect(uuids(seenA)).toEqual(["u3"]);
    await scannerA.cleanup();

    // Simulate the CLI process restarting: a brand-new scanner instance
    // (fresh in-memory dedup state) is pointed at the same, now-longer file.
    const seenB: RawJSONLines[] = [];
    const scannerB = await createSessionScanner({
      sessionId: "sess-restart",
      workingDirectory,
      onMessage: (m) => seenB.push(m),
      missingFileTimeoutMs: 100_000,
      pollIntervalMs: 60,
      env,
    });
    scanner = scannerB;
    await sleep(200);
    // Everything already on disk (u1, u2, u3) is existing history again on
    // the new instance — none of it is replayed as new.
    expect(seenB).toEqual([]);

    await appendFile(file, userLine("u4"));
    await sleep(250);
    expect(uuids(seenB)).toEqual(["u4"]);
  });

  it("drops a session whose transcript never appears and stops re-watching it (dead-instance guard)", async () => {
    const { logger, debugRecords } = collectingLogger();
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory,
      onMessage: () => {},
      missingFileTimeoutMs: 100,
      pollIntervalMs: 50,
      logger,
      env,
    });

    await scanner.onNewSession("sess-phantom");

    // Give the watcher enough time to fail once (~1s internal backoff),
    // give up, and then let several more poll ticks pass. If the
    // `deadSessions` guard did not work, the scanner would keep
    // re-creating a watcher (and re-logging "starting watcher") on every
    // one of those ticks instead of exactly once.
    await sleep(2500);

    const forPhantom = debugRecords.filter((r) => r.meta?.sessionId === "sess-phantom");
    const startedWatcher = forPhantom.filter(
      (r) => r.message === "[SESSION_SCANNER] starting watcher",
    );
    const gaveUp = forPhantom.filter((r) =>
      r.message.includes("session transcript never appeared — dropping"),
    );

    expect(startedWatcher.length).toBe(1);
    expect(gaveUp.length).toBe(1);
  });

  it("revives a previously-dropped session id via onNewSession and resumes watching once its file exists", async () => {
    const { logger, debugRecords } = collectingLogger();
    const seen: RawJSONLines[] = [];
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory,
      onMessage: (m) => seen.push(m),
      missingFileTimeoutMs: 100,
      pollIntervalMs: 50,
      logger,
      env,
    });

    await scanner.onNewSession("sess-revive");
    await sleep(1500); // long enough for the give-up to fire once

    const gaveUpBefore = debugRecords.filter((r) =>
      r.message.includes("session transcript never appeared — dropping"),
    );
    expect(gaveUpBefore.length).toBe(1);
    expect(seen).toEqual([]);

    // Move off "sess-revive" so re-announcing it isn't a same-session
    // no-op (onNewSession short-circuits when the id is already current),
    // then let its transcript file show up before revival — e.g. the
    // provider process was just slow to start.
    await scanner.onNewSession("sess-other");
    await writeFile(join(projectDir, "sess-revive.jsonl"), userLine("u1"));
    await scanner.onNewSession("sess-revive");
    await sleep(300);

    const revivedAfter = debugRecords.filter((r) =>
      r.message.includes("reviving previously-dropped session"),
    );
    expect(revivedAfter.length).toBe(1);
    expect(uuids(seen)).toEqual(["u1"]);
  });

  it("dedupes summary lines by leafUuid+summary and skips internal/malformed lines", async () => {
    const seen: RawJSONLines[] = [];
    const file = join(projectDir, "sess-mixed.jsonl");
    await writeFile(file, userLine("u1"));

    scanner = await createSessionScanner({
      sessionId: "sess-mixed",
      workingDirectory,
      onMessage: (m) => seen.push(m),
      missingFileTimeoutMs: 100_000,
      pollIntervalMs: 60,
      env,
    });
    await sleep(150);
    expect(seen).toEqual([]);

    // Append: a duplicate-content summary (should only ever be counted once
    // even though it's appended twice with the same identity), an internal
    // event type that must be silently skipped, and an unparsable line that
    // must not crash the scanner or block subsequent valid entries.
    await appendFile(file, summaryLine("leaf-1", "does a thing"));
    await appendFile(file, internalLine("file-history-snapshot"));
    await appendFile(file, internalLine("queue-operation"));
    await appendFile(file, "not json at all {{{\n");
    await appendFile(file, userLine("u2"));
    await sleep(300);

    expect(seen.map((m) => m.type)).toEqual(["summary", "user"]);
    expect((seen[0] as { leafUuid: string }).leafUuid).toBe("leaf-1");
    expect(uuids(seen.filter((m) => m.type === "user"))).toEqual(["u2"]);

    // Re-appending the identical summary content must not re-emit it (same
    // dedup key: `summary:leafUuid:summary`).
    await appendFile(file, summaryLine("leaf-1", "does a thing"));
    await sleep(300);
    expect(seen.filter((m) => m.type === "summary").length).toBe(1);
  });

  it("treatExistingAsProcessed pre-marks on-disk entries so they are not replayed as new", async () => {
    const seen: RawJSONLines[] = [];
    const file = join(projectDir, "sess-reconnect.jsonl");
    await writeFile(file, userLine("u1") + userLine("u2"));

    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory,
      onMessage: (m) => seen.push(m),
      missingFileTimeoutMs: 100_000,
      pollIntervalMs: 60,
      env,
    });

    await scanner.onNewSession("sess-reconnect", { treatExistingAsProcessed: true });
    await sleep(200);
    // u1/u2 were already on disk and pre-marked processed: must not surface.
    expect(seen).toEqual([]);

    await appendFile(file, userLine("u3"));
    await sleep(250);
    expect(uuids(seen)).toEqual(["u3"]);
  });

  it("keeps scanning the previous session after onNewSession moves it to pending", async () => {
    const seen: RawJSONLines[] = [];
    const oldFile = join(projectDir, "sess-old.jsonl");
    const newFile = join(projectDir, "sess-new.jsonl");
    await writeFile(oldFile, userLine("old-1"));

    scanner = await createSessionScanner({
      sessionId: "sess-old",
      workingDirectory,
      onMessage: (m) => seen.push(m),
      missingFileTimeoutMs: 100_000,
      pollIntervalMs: 60,
      env,
    });
    await sleep(150);

    // Simulate a `--resume` into a new session id: the old session must
    // keep being watched (agent tasks can still append to it) rather than
    // being dropped outright.
    await scanner.onNewSession("sess-new");
    await writeFile(newFile, "");
    await sleep(150);

    await appendFile(oldFile, userLine("old-2"));
    await appendFile(newFile, userLine("new-1"));
    await sleep(300);

    expect(uuids(seen).sort()).toEqual(["new-1", "old-2"]);
  });

  it("maps shutdown-tail entries appended right before cleanup() (W3.8 final sync pass)", async () => {
    const seen: RawJSONLines[] = [];
    const file = join(projectDir, "sess-shutdown.jsonl");
    await writeFile(file, userLine("u1"));

    scanner = await createSessionScanner({
      sessionId: "sess-shutdown",
      workingDirectory,
      onMessage: (m) => seen.push(m),
      missingFileTimeoutMs: 100_000,
      // A long poll interval so the periodic tick can't be the one that
      // happens to pick this up — only the final pass inside cleanup() can.
      pollIntervalMs: 60_000,
      env,
    });

    // Appended after the scanner started but before any poll tick or
    // fs-watcher callback has had a chance to run.
    await appendFile(file, userLine("u2"));
    const scannerToCleanup = scanner;
    scanner = null;
    await scannerToCleanup.cleanup();

    expect(uuids(seen)).toEqual(["u2"]);
  });

  it("rotates onto a new session automatically when no SessionStart hook has ever fired (rotation fallback, no-hook coverage)", async () => {
    const { logger, infoRecords } = collectingLogger();
    const seen: RawJSONLines[] = [];

    // `sessionId: null` at construction and no `onNewSession` call for the
    // life of this test — this is the genuine "no hook coverage at all"
    // case (a native Claude Code install without the hook wired up). The
    // fallback must be the only way this scanner ever discovers a session,
    // and it must still work, just time-boxed (see the expiry test below).
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory,
      onMessage: (m) => seen.push(m),
      missingFileTimeoutMs: 100_000,
      pollIntervalMs: 60_000,
      logger,
      env,
    });
    await sleep(100);

    const newFile = join(projectDir, "sess-rotate-new.jsonl");
    await writeFile(newFile, userLine("new-1"));

    // The rotation fallback debounces 2s before acting; give it enough room.
    await sleep(3000);

    expect(uuids(seen)).toContain("new-1");
    const rotationLogs = infoRecords.filter((r) =>
      r.message.includes("new transcript file detected"),
    );
    expect(rotationLogs.length).toBe(1);
    expect(rotationLogs[0]?.meta?.newSessionId).toBe("sess-rotate-new");
  }, 10_000);

  it("never adopts a sibling transcript file once hook-confirmed, even after its own tracked session was dropped", async () => {
    const { logger, debugRecords } = collectingLogger();
    const seen: RawJSONLines[] = [];

    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory,
      onMessage: (m) => seen.push(m),
      missingFileTimeoutMs: 100,
      pollIntervalMs: 50,
      logger,
      env,
    });

    // Simulate the hook firing once for session A — this is what flips
    // `hookConfirmed` to true for the rest of this scanner's life.
    await scanner.onNewSession("A");

    // A's transcript file never appears, so its watcher gives up and A is
    // blacklisted into `deadSessions` (~1s internal backoff for one retry).
    await sleep(1500);
    const gaveUp = debugRecords.filter((r) =>
      r.message.includes("session transcript never appeared — dropping"),
    );
    expect(gaveUp.length).toBe(1);

    // A sibling session's brand-new transcript file now appears in the same
    // directory (e.g. an unrelated tmux pane running Claude Code against the
    // same cwd). Even though A is dead, hook coverage was already proven, so
    // this must never be adopted.
    await writeFile(join(projectDir, "B.jsonl"), userLine("b-1"));
    await sleep(3000);

    expect(uuids(seen)).toEqual([]);
    const ignored = debugRecords.filter((r) =>
      r.message.includes("ignoring unrelated new transcript file (hook coverage active)"),
    );
    expect(ignored.length).toBeGreaterThan(0);
    expect(ignored[0]?.meta?.newSessionId).toBe("B");
  }, 10_000);

  it("a hook confirming the same session the fallback already adopted still permanently blocks later siblings", async () => {
    const { logger, debugRecords, infoRecords } = collectingLogger();
    const seen: RawJSONLines[] = [];

    // Starts with genuinely no hook coverage, so the fallback is free to
    // adopt "A" on its own — this is the realistic sequence for a
    // `SessionStart` hook that fires late (e.g. right as Claude Code
    // finishes writing the first transcript line) rather than not at all:
    // the fallback beats it to the adoption, and the hook call that follows
    // is for the *same* session id, not a different one.
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory,
      onMessage: (m) => seen.push(m),
      missingFileTimeoutMs: 100_000,
      pollIntervalMs: 60_000,
      fallbackArmedWindowMs: 100_000,
      logger,
      env,
    });

    await writeFile(join(projectDir, "A.jsonl"), userLine("a-1"));
    // The rotation fallback debounces 2s before acting; give it enough room
    // (bumped from 3s — 2s margin observed too tight under real contention).
    await sleep(4000);

    expect(uuids(seen)).toContain("a-1");
    const rotationLogs = infoRecords.filter((r) =>
      r.message.includes("new transcript file detected"),
    );
    expect(rotationLogs.length).toBe(1);
    expect(rotationLogs[0]?.meta?.newSessionId).toBe("A");

    // The hook now fires for the very same session id the fallback already
    // adopted. `announceNewSession` no-ops on the "already current" check,
    // but the wrapping `onNewSession` still flips `hookConfirmed` — this is
    // the realistic "hook arrived, just later than the fallback" case, and
    // it must lock out the fallback for good from this point on.
    await scanner.onNewSession("A");

    await writeFile(join(projectDir, "B.jsonl"), userLine("b-1"));
    await sleep(4000);

    expect(uuids(seen)).toEqual(["a-1"]);
    const ignored = debugRecords.filter((r) =>
      r.message.includes("ignoring unrelated new transcript file (hook coverage active)"),
    );
    expect(ignored.length).toBeGreaterThan(0);
    expect(ignored[0]?.meta?.newSessionId).toBe("B");
  }, 15_000);

  it("ignores a new transcript file once the fallback's armed window has expired, even with no hook coverage", async () => {
    const { logger, debugRecords } = collectingLogger();
    const seen: RawJSONLines[] = [];

    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory,
      onMessage: (m) => seen.push(m),
      missingFileTimeoutMs: 100_000,
      pollIntervalMs: 60_000,
      // Short armed window so the test doesn't need to wait the real 30s
      // default — see `SessionScannerOptions.fallbackArmedWindowMs`.
      fallbackArmedWindowMs: 200,
      logger,
      env,
    });

    // Let the armed window lapse with no hook ever confirming anything.
    await sleep(400);

    const newFile = join(projectDir, "sess-rotate-late.jsonl");
    await writeFile(newFile, userLine("late-1"));
    await sleep(3000);

    expect(uuids(seen)).toEqual([]);
    const expired = debugRecords.filter((r) =>
      r.message.includes("ignoring new transcript file — fallback window expired"),
    );
    expect(expired.length).toBeGreaterThan(0);
    expect(expired[0]?.meta?.newSessionId).toBe("sess-rotate-late");
  }, 10_000);

  it("ignores non-.jsonl files created in the project directory (rotation fallback ignores unrelated renames)", async () => {
    const { logger, infoRecords } = collectingLogger();
    const seen: RawJSONLines[] = [];

    scanner = await createSessionScanner({
      sessionId: "sess-ignore-noise",
      workingDirectory,
      onMessage: (m) => seen.push(m),
      missingFileTimeoutMs: 100_000,
      pollIntervalMs: 60_000,
      logger,
      env,
    });
    await sleep(100);

    // A non-`.jsonl` file (e.g. a lock/tmp file some other tool writes into
    // the same project dir) must never be treated as a session rotation.
    await writeFile(join(projectDir, "sess-noise.jsonl.tmp"), "not a transcript");
    await writeFile(join(projectDir, ".DS_Store"), "");
    await sleep(3000);

    expect(seen).toEqual([]);
    expect(infoRecords.filter((r) => r.message.includes("new transcript file detected"))).toEqual(
      [],
    );
  }, 10_000);
});
