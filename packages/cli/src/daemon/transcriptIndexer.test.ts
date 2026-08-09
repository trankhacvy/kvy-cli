import { existsSync } from "node:fs";
import { appendFile, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProjectPath } from "../claude/scanner.js";
import type { ProcessEntry } from "./processScan.js";
import {
  parseTranscript,
  type RegisteredWorkspace,
  startTranscriptIndexer,
  type TranscriptIndexerDeps,
  type TranscriptIndexerHandle,
} from "./transcriptIndexer.js";
import type { UpsertUnmanagedSessionParams } from "./unmanagedSessionClient.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function userLine(text: string, timestamp = "2026-01-01T00:00:00.000Z"): string {
  return `${JSON.stringify({ type: "user", uuid: "u1", timestamp, message: { role: "user", content: text } })}\n`;
}

function summaryLine(summary: string): string {
  return `${JSON.stringify({ type: "summary", leafUuid: "u1", summary })}\n`;
}

describe("parseTranscript", () => {
  it("prefers the summary line's title over the first user message", () => {
    const contents = userLine("say lol") + summaryLine("Casual Chat: Simple Greeting Exchange");
    expect(parseTranscript(contents)).toEqual({
      title: "Casual Chat: Simple Greeting Exchange",
      lastActivity: Date.parse("2026-01-01T00:00:00.000Z"),
    });
  });

  it("falls back to the first user message text, truncated to one line", () => {
    const contents = userLine("run ls tool please and also do many other things\nwith a newline");
    const parsed = parseTranscript(contents);
    expect(parsed?.title).toBe("run ls tool please and also do many other things with a newline");
  });

  it("falls back to a generic title when nothing usable is found", () => {
    const contents = `${JSON.stringify({ type: "system", uuid: "s1" })}\n`;
    expect(parseTranscript(contents)?.title).toBe("Untitled session");
  });

  it("returns null for an empty/unwritten file", () => {
    expect(parseTranscript("")).toBeNull();
    expect(parseTranscript("\n\n")).toBeNull();
  });

  it("skips unparsable lines instead of failing the whole file", () => {
    const contents = `not json\n${userLine("hello")}`;
    expect(parseTranscript(contents)?.title).toBe("hello");
  });

  it("extracts text from array-shaped message content, ignoring tool blocks", () => {
    const line = `${JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "array content title" }] },
    })}\n`;
    expect(parseTranscript(line)?.title).toBe("array content title");
  });
});

describe("startTranscriptIndexer", () => {
  let baseDir: string;
  let claudeConfigDir: string;
  let workspacePath: string;
  let projectDir: string;
  let env: NodeJS.ProcessEnv;
  let handle: TranscriptIndexerHandle | null = null;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    baseDir = join(tmpdir(), `transcript-indexer-test-${unique}`);
    claudeConfigDir = join(baseDir, "claude-home");
    workspacePath = join(baseDir, "project");
    env = { CLAUDE_CONFIG_DIR: claudeConfigDir };
    projectDir = getProjectPath(workspacePath, env);
    await mkdir(projectDir, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    handle?.stop();
    handle = null;
    if (existsSync(baseDir)) {
      await rm(baseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  function baseWorkspace(): RegisteredWorkspace {
    return { workspaceId: "ws-1", path: workspacePath };
  }

  function baseDeps(overrides: Partial<TranscriptIndexerDeps> = {}): TranscriptIndexerDeps {
    return {
      machineId: "machine-1",
      listWorkspaces: async () => [baseWorkspace()],
      upsert: async () => true,
      isManaged: () => false,
      listProcesses: async () => [] as ProcessEntry[],
      resolveProcessCwd: async () => null,
      debounceMs: 30,
      rescanWorkspacesMs: 100_000,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      env,
      ...overrides,
    };
  }

  it("indexes a pre-existing transcript on startup without waiting for a change event", async () => {
    await writeFile(join(projectDir, "sess-1.jsonl"), userLine("say lol") + summaryLine("Say lol"));

    const upserts: UpsertUnmanagedSessionParams[] = [];
    handle = startTranscriptIndexer(
      baseDeps({
        upsert: async (params) => {
          upserts.push(params);
          return true;
        },
      }),
    );

    await sleep(300);

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      machineId: "machine-1",
      workspaceId: "ws-1",
      providerRef: "sess-1",
      summary: { title: "Say lol", running: false },
    });
  });

  it("debounces rapid successive appends into a single upsert", async () => {
    const file = join(projectDir, "sess-2.jsonl");
    await writeFile(file, userLine("first"));

    const upserts: UpsertUnmanagedSessionParams[] = [];
    handle = startTranscriptIndexer(
      baseDeps({
        debounceMs: 300,
        upsert: async (params) => {
          upserts.push(params);
          return true;
        },
      }),
    );

    // Wait past the initial-scan upsert.
    await sleep(500);
    expect(upserts).toHaveLength(1);

    // Rapid-fire several appends, all well within the 300ms debounce window.
    for (let i = 0; i < 5; i++) {
      await appendFile(file, summaryLine(`Revision ${i}`));
    }

    await sleep(600);

    // Exactly one more upsert for the whole burst, carrying the last write.
    expect(upserts).toHaveLength(2);
    expect(upserts[1]?.summary.title).toBe("Revision 4");
  });

  it("skips providerRefs reported as already-managed", async () => {
    await writeFile(join(projectDir, "sess-managed.jsonl"), userLine("hello"));

    const upserts: UpsertUnmanagedSessionParams[] = [];
    handle = startTranscriptIndexer(
      baseDeps({
        upsert: async (params) => {
          upserts.push(params);
          return true;
        },
        isManaged: (providerRef) => providerRef === "sess-managed",
      }),
    );

    await sleep(300);
    expect(upserts).toHaveLength(0);
  });

  it("marks the most-recently-modified transcript as running when a live plain `claude` process's cwd matches the workspace", async () => {
    await writeFile(join(projectDir, "sess-old.jsonl"), userLine("old session"));
    await sleep(10);
    await writeFile(join(projectDir, "sess-new.jsonl"), userLine("new session"));

    const upserts: UpsertUnmanagedSessionParams[] = [];
    handle = startTranscriptIndexer(
      baseDeps({
        upsert: async (params) => {
          upserts.push(params);
          return true;
        },
        listProcesses: async () => [{ pid: 999, ppid: 1, command: "claude --resume" }],
        resolveProcessCwd: async (pid) => (pid === 999 ? workspacePath : null),
      }),
    );

    await sleep(400);

    const byRef = new Map(upserts.map((u) => [u.providerRef, u]));
    expect(byRef.get("sess-old")?.summary.running).toBe(false);
    expect(byRef.get("sess-new")?.summary.running).toBe(true);
  });

  it("never reports running for a Kvy-managed `kvy claude` process (only bare `claude`)", async () => {
    await writeFile(join(projectDir, "sess-1.jsonl"), userLine("hi"));

    const upserts: UpsertUnmanagedSessionParams[] = [];
    handle = startTranscriptIndexer(
      baseDeps({
        upsert: async (params) => {
          upserts.push(params);
          return true;
        },
        listProcesses: async () => [
          { pid: 111, ppid: 1, command: "kvy claude --starting-mode remote" },
        ],
        resolveProcessCwd: async () => workspacePath,
      }),
    );

    await sleep(300);
    expect(upserts[0]?.summary.running).toBe(false);
  });

  it("picks up a brand-new session file appearing after startup (fs-watch, not just the initial scan)", async () => {
    const upserts: UpsertUnmanagedSessionParams[] = [];
    handle = startTranscriptIndexer(
      baseDeps({
        upsert: async (params) => {
          upserts.push(params);
          return true;
        },
      }),
    );

    await sleep(100);
    expect(upserts).toHaveLength(0);

    await writeFile(join(projectDir, "sess-fresh.jsonl"), userLine("brand new"));
    await sleep(400);

    expect(upserts.some((u) => u.providerRef === "sess-fresh")).toBe(true);
  });

  it("tolerates a workspace whose project directory doesn't exist yet", async () => {
    const missingWorkspacePath = join(baseDir, "not-yet-a-project");
    const upserts: UpsertUnmanagedSessionParams[] = [];

    handle = startTranscriptIndexer(
      baseDeps({
        listWorkspaces: async () => [{ workspaceId: "ws-missing", path: missingWorkspacePath }],
        upsert: async (params) => {
          upserts.push(params);
          return true;
        },
      }),
    );

    await sleep(200);
    expect(upserts).toHaveLength(0); // no crash, nothing to index yet

    const missingProjectDir = getProjectPath(missingWorkspacePath, env);
    await mkdir(missingProjectDir, { recursive: true });
    await writeFile(join(missingProjectDir, "sess-late.jsonl"), userLine("finally started"));

    // The directory watcher's ENOENT retry backs off starting at ~1s (see
    // `watchDirectoryForever`), so this has to wait past that first retry.
    await sleep(1700);
    expect(upserts.some((u) => u.providerRef === "sess-late")).toBe(true);
  }, 10_000);

  describe("registeredAt gating", () => {
    it("upserts nothing for a transcript untouched since long before registeredAt (pre-Kvy history)", async () => {
      await writeFile(join(projectDir, "sess-history.jsonl"), userLine("months-old chat"));
      // Registered two hours "from now" relative to the file's real write time — well
      // outside the one-hour first-registration grace window.
      const registeredAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

      const upserts: UpsertUnmanagedSessionParams[] = [];
      handle = startTranscriptIndexer(
        baseDeps({
          listWorkspaces: async () => [{ ...baseWorkspace(), registeredAt }],
          upsert: async (params) => {
            upserts.push(params);
            return true;
          },
          // watchWorkspace's own initial scan and watchDirectoryForever's onReady scan
          // (an intentional redundant catch-up scan, not a bug — see its doc comment)
          // both fire on first attach; the debounce window is what coalesces them into
          // one processFile call. The default 30ms is too tight under contention (the
          // two scans can land further apart than that), so widen it here — same
          // reasoning as the neighboring "upserts once" test.
          debounceMs: 300,
        }),
      );

      await sleep(900);
      expect(upserts).toHaveLength(0);
    });

    it("upserts once the transcript's mtime moves inside [registeredAt - grace, ∞)", async () => {
      const file = join(projectDir, "sess-resumed.jsonl");
      await writeFile(file, userLine("resumed session"));
      const registeredAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      // Inside the grace window: registeredAt minus 30 minutes, under the 60-minute cap.
      const freshMtime = new Date(Date.parse(registeredAt) - 30 * 60 * 1000);
      await utimes(file, freshMtime, freshMtime);

      const upserts: UpsertUnmanagedSessionParams[] = [];
      handle = startTranscriptIndexer(
        baseDeps({
          listWorkspaces: async () => [{ ...baseWorkspace(), registeredAt }],
          upsert: async (params) => {
            upserts.push(params);
            return true;
          },
          // watchWorkspace's initial scanExisting() and watchDirectoryForever's onReady
          // callback both scan on first attach (intentionally — onReady closes the race
          // between "scan finished" and "watch() actually attached"). The debounce timer
          // is what's supposed to coalesce both scans' scheduleProcess() calls into one
          // processFile() run — but with the default 30ms debounce, real scheduling delay
          // between the two scans under contention can exceed the window, so the first
          // timer already fires (and clears itself) before the second scan re-triggers a
          // new one, producing a genuine duplicate upsert. Widen the debounce well past
          // any realistic inter-scan delay instead.
          debounceMs: 300,
        }),
      );

      await sleep(900);
      expect(upserts).toHaveLength(1);
      expect(upserts[0]?.providerRef).toBe("sess-resumed");
    });

    it("an absent registeredAt indexes everything (existing tests' fixtures stay valid)", async () => {
      await writeFile(join(projectDir, "sess-no-registered-at.jsonl"), userLine("anything"));
      const upserts: UpsertUnmanagedSessionParams[] = [];
      handle = startTranscriptIndexer(
        baseDeps({
          upsert: async (params) => {
            upserts.push(params);
            return true;
          },
          // Same coalescing-window reasoning as the two tests above.
          debounceMs: 300,
        }),
      );

      await sleep(900);
      expect(upserts).toHaveLength(1);
    });
  });
});
