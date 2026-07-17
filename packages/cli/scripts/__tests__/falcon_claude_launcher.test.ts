import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODULE_PATH = path.join(__dirname, "../falcon_claude_launcher.cjs");

type FetchModule = {
  getClaudeCliPath: () => string;
  runClaudeCli: (cliPath: string) => void;
  writeMessage: (message: unknown) => void;
};

/** Fresh require of the launcher, bypassing Node's require cache. */
function loadLauncher(): FetchModule {
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH) as FetchModule;
}

describe("falcon_claude_launcher.cjs — fetch-patch fd3 signal", () => {
  let originalFetch: typeof global.fetch;
  let originalDisableAutoupdater: string | undefined;
  let originalClaudePathEnv: string | undefined;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalDisableAutoupdater = process.env.DISABLE_AUTOUPDATER;
    originalClaudePathEnv = process.env.FALCON_CLAUDE_PATH;
    delete require.cache[require.resolve(MODULE_PATH)];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalDisableAutoupdater === undefined) {
      delete process.env.DISABLE_AUTOUPDATER;
    } else {
      process.env.DISABLE_AUTOUPDATER = originalDisableAutoupdater;
    }
    if (originalClaudePathEnv === undefined) {
      delete process.env.FALCON_CLAUDE_PATH;
    } else {
      process.env.FALCON_CLAUDE_PATH = originalClaudePathEnv;
    }
    delete require.cache[require.resolve(MODULE_PATH)];
    vi.restoreAllMocks();
  });

  it("sets DISABLE_AUTOUPDATER on require", () => {
    delete process.env.DISABLE_AUTOUPDATER;
    loadLauncher();
    expect(process.env.DISABLE_AUTOUPDATER).toBe("1");
  });

  it("wraps global.fetch with a new function on require", () => {
    const mockFetch = vi.fn(async () => new Response("ok"));
    global.fetch = mockFetch as unknown as typeof global.fetch;

    loadLauncher();

    expect(global.fetch).not.toBe(mockFetch);
    expect(typeof global.fetch).toBe("function");
  });

  it("emits a well-formed fetch-start JSON line on fd 3 before calling the real fetch", async () => {
    const mockFetch = vi.fn(async () => new Response("ok"));
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const writeSyncSpy = vi.spyOn(fs, "writeSync").mockImplementation(() => 0);

    loadLauncher();
    await global.fetch("https://api.example.com/v1/messages", { method: "POST" });

    const fd3Calls = writeSyncSpy.mock.calls.filter(([fd]) => fd === 3);
    expect(fd3Calls.length).toBeGreaterThanOrEqual(2);

    const startLine = fd3Calls[0]?.[1] as string;
    expect(startLine.endsWith("\n")).toBe(true);
    const startMsg = JSON.parse(startLine.trimEnd());

    expect(startMsg).toEqual(
      expect.objectContaining({
        type: "fetch-start",
        id: expect.any(Number),
        hostname: "api.example.com",
        path: "/v1/messages",
        method: "POST",
        timestamp: expect.any(Number),
      }),
    );

    // The real fetch must still be invoked with the original arguments.
    expect(mockFetch).toHaveBeenCalledWith("https://api.example.com/v1/messages", {
      method: "POST",
    });
  });

  it("emits a matching fetch-end JSON line (same id) after the fetch resolves", async () => {
    const mockFetch = vi.fn(async () => new Response("ok"));
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const writeSyncSpy = vi.spyOn(fs, "writeSync").mockImplementation(() => 0);

    loadLauncher();
    await global.fetch("https://api.example.com/foo");

    const fd3Lines = writeSyncSpy.mock.calls
      .filter(([fd]) => fd === 3)
      .map(([, data]) => JSON.parse((data as string).trimEnd()));

    const start = fd3Lines.find((m) => m.type === "fetch-start");
    const end = fd3Lines.find((m) => m.type === "fetch-end");

    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(end.id).toBe(start.id);
    expect(typeof end.timestamp).toBe("number");
  });

  it("still emits fetch-end when the underlying fetch rejects", async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error("network down");
    });
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const writeSyncSpy = vi.spyOn(fs, "writeSync").mockImplementation(() => 0);

    loadLauncher();
    await expect(global.fetch("https://api.example.com/foo")).rejects.toThrow("network down");

    // Let the attached .then(sendEnd, sendEnd) handlers flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const types = writeSyncSpy.mock.calls
      .filter(([fd]) => fd === 3)
      .map(([, data]) => JSON.parse((data as string).trimEnd()).type);

    expect(types).toEqual(["fetch-start", "fetch-end"]);
  });

  it("assigns increasing ids across multiple concurrent fetches", async () => {
    const mockFetch = vi.fn(async () => new Response("ok"));
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const writeSyncSpy = vi.spyOn(fs, "writeSync").mockImplementation(() => 0);

    loadLauncher();
    await Promise.all([
      global.fetch("https://a.example.com/one"),
      global.fetch("https://b.example.com/two"),
    ]);

    const starts = writeSyncSpy.mock.calls
      .filter(([fd]) => fd === 3)
      .map(([, data]) => JSON.parse((data as string).trimEnd()))
      .filter((m) => m.type === "fetch-start");

    expect(starts.map((m) => m.id)).toEqual([1, 2]);
    expect(starts.map((m) => m.hostname)).toEqual(["a.example.com", "b.example.com"]);
  });

  it("never touches stdout or stderr — only fd 3", async () => {
    const mockFetch = vi.fn(async () => new Response("ok"));
    global.fetch = mockFetch as unknown as typeof global.fetch;
    vi.spyOn(fs, "writeSync").mockImplementation(() => 0);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    loadLauncher();
    await global.fetch("https://api.example.com/foo");

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("writeMessage swallows errors when fd 3 is unavailable (no throw, no stdout/stderr fallback)", () => {
    vi.spyOn(fs, "writeSync").mockImplementation(() => {
      throw new Error("EBADF: bad file descriptor");
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { writeMessage } = loadLauncher();

    expect(() => writeMessage({ type: "fetch-start", id: 1 })).not.toThrow();
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("falls back to the 'http://localhost' base when args[0] is missing", async () => {
    const mockFetch = vi.fn(async () => new Response("ok"));
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const writeSyncSpy = vi.spyOn(fs, "writeSync").mockImplementation(() => 0);

    loadLauncher();
    await global.fetch(null as unknown as string);

    const start = writeSyncSpy.mock.calls
      .filter(([fd]) => fd === 3)
      .map(([, data]) => JSON.parse((data as string).trimEnd()))
      .find((m) => m.type === "fetch-start");

    expect(start.hostname).toBe("localhost");
  });

  it("falls back to hostname 'unknown' when the URL is genuinely unparseable", async () => {
    const mockFetch = vi.fn(async () => new Response("ok"));
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const writeSyncSpy = vi.spyOn(fs, "writeSync").mockImplementation(() => 0);
    const malformed = "http://[bad";

    loadLauncher();
    await global.fetch(malformed);

    const start = writeSyncSpy.mock.calls
      .filter(([fd]) => fd === 3)
      .map(([, data]) => JSON.parse((data as string).trimEnd()))
      .find((m) => m.type === "fetch-start");

    expect(start.hostname).toBe("unknown");
    expect(start.path).toBe(malformed);
  });
});

describe("falcon_claude_launcher.cjs — getClaudeCliPath stub", () => {
  beforeEach(() => {
    delete require.cache[require.resolve(MODULE_PATH)];
  });

  it("defaults to the bare 'claude' command", () => {
    delete process.env.FALCON_CLAUDE_PATH;
    const { getClaudeCliPath } = loadLauncher();
    expect(getClaudeCliPath()).toBe("claude");
  });

  it("honors FALCON_CLAUDE_PATH when set", () => {
    process.env.FALCON_CLAUDE_PATH = "/opt/custom/claude/cli.js";
    const { getClaudeCliPath } = loadLauncher();
    expect(getClaudeCliPath()).toBe("/opt/custom/claude/cli.js");
    delete process.env.FALCON_CLAUDE_PATH;
  });
});

describe("falcon_claude_launcher.cjs — runClaudeCli binary-spawn path", () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete require.cache[require.resolve(MODULE_PATH)];
    originalArgv = process.argv;
    process.argv = ["node", "falcon_claude_launcher.cjs", "--resume", "abc123"];
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("spawns a native-binary CLI path (no .js/.cjs extension) directly, forwarding argv and stdio", () => {
    const spawnSyncSpy = vi
      .spyOn(childProcess, "spawnSync")
      .mockReturnValue({ status: 0, signal: null, error: undefined } as never);

    const { runClaudeCli } = loadLauncher();
    runClaudeCli("/Users/x/.local/share/claude/versions/2.1.212");

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      "/Users/x/.local/share/claude/versions/2.1.212",
      ["--resume", "abc123"],
      { stdio: "inherit" },
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits with the spawned binary's non-zero status", () => {
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 7,
      signal: null,
      error: undefined,
    } as never);

    const { runClaudeCli } = loadLauncher();
    runClaudeCli("/opt/claude-native");

    expect(exitSpy).toHaveBeenCalledWith(7);
  });

  it("re-raises the child's signal on this process instead of calling exit", () => {
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: null,
      signal: "SIGTERM",
      error: undefined,
    } as never);

    const { runClaudeCli } = loadLauncher();
    runClaudeCli("/opt/claude-native");

    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("throws when spawnSync itself reports an error (e.g. ENOENT)", () => {
    const spawnError = new Error("spawnSync /opt/claude-native ENOENT");
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: null,
      signal: null,
      error: spawnError,
    } as never);

    const { runClaudeCli } = loadLauncher();
    expect(() => runClaudeCli("/opt/claude-native")).toThrow(spawnError);
  });
});
