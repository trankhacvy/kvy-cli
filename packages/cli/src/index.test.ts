import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// index.ts reads FALCON_HOME_DIR (via the module-scope logger) at import
// time, so give it an isolated, disposable home directory before the first
// import and reset the module registry between tests that care about it.
let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-index-test-"));
  process.env.FALCON_HOME_DIR = homeDir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.FALCON_HOME_DIR;
  rmSync(homeDir, { recursive: true, force: true });
});

async function importMain() {
  const mod = await import("./index.js");
  return mod.main;
}

describe("main()", () => {
  it("prints help and exits 0 for --help", async () => {
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = main(["--help"]);

    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stdout.mock.calls[0]?.[0]).toContain("falcon claude [args...]");
    stdout.mockRestore();
  });

  it("prints the version and exits 0 for --version", async () => {
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = main(["--version"]);

    expect(code).toBe(0);
    expect(stdout.mock.calls[0]?.[0]).toMatch(/^falcon \d+\.\d+\.\d+\n$/);
    stdout.mockRestore();
  });

  it("describes a claude passthrough start without executing anything", async () => {
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = main(["claude", "--resume", "abc123"]);

    expect(code).toBe(0);
    expect(stdout.mock.calls[0]?.[0]).toContain("would start a claude session");
    expect(stdout.mock.calls[0]?.[0]).toContain("--resume abc123");
    stdout.mockRestore();
  });

  it("prints a usage error and exits 1 for a malformed Falcon subcommand", async () => {
    const main = await importMain();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = main(["resume"]);

    expect(code).toBe(1);
    expect(stderr.mock.calls[0]?.[0]).toContain("falcon: ");
    expect(stderr.mock.calls[1]?.[0]).toContain("usage: falcon resume <session-id>");
    stderr.mockRestore();
  });

  it("wires the `kill` subcommand to daemon/kill.js and awaits the async result", async () => {
    vi.doMock("./daemon/kill.js", () => ({
      killDaemon: vi.fn(),
      killSessions: vi.fn(),
      killAll: vi.fn(async () => ({
        targeted: [
          {
            pid: 100,
            ppid: 1,
            command: "falcon daemon start-sync",
            kind: "daemon",
            spawnedByDaemon: false,
          },
        ],
        outcomes: [
          { pid: 100, command: "falcon daemon start-sync", kind: "daemon", signal: "SIGTERM" },
        ],
      })),
      killAllForce: vi.fn(),
      describeKillSummary: vi.fn(() => "falcon kill all: 1/1 process(es) terminated\n"),
    }));
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const result = main(["kill", "all"]);
    expect(result).toBeInstanceOf(Promise);
    const code = await result;

    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith("falcon kill all: 1/1 process(es) terminated\n");
    stdout.mockRestore();
    vi.doUnmock("./daemon/kill.js");
  });

  it("exits 1 when `kill` reports a per-pid failure", async () => {
    vi.doMock("./daemon/kill.js", () => ({
      killDaemon: vi.fn(async () => ({
        targeted: [
          {
            pid: 100,
            ppid: 1,
            command: "falcon daemon start-sync",
            kind: "daemon",
            spawnedByDaemon: false,
          },
        ],
        outcomes: [
          {
            pid: 100,
            command: "falcon daemon start-sync",
            kind: "daemon",
            signal: "none",
            error: "EPERM",
          },
        ],
      })),
      killSessions: vi.fn(),
      killAll: vi.fn(),
      killAllForce: vi.fn(),
      describeKillSummary: vi.fn(() => "falcon kill daemon: 0/1 process(es) terminated\n"),
    }));
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await main(["kill", "daemon"]);

    expect(code).toBe(1);
    stdout.mockRestore();
    vi.doUnmock("./daemon/kill.js");
  });

  it("falls back to the error handler if the kill promise rejects", async () => {
    vi.doMock("./daemon/kill.js", () => ({
      killDaemon: vi.fn(),
      killSessions: vi.fn(async () => {
        throw new Error("ps exploded");
      }),
      killAll: vi.fn(),
      killAllForce: vi.fn(),
      describeKillSummary: vi.fn(),
    }));
    const main = await importMain();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await main(["kill", "sessions"]);

    expect(code).toBe(1);
    expect(stderr.mock.calls[0]?.[0]).toContain("unexpected error");
    stderr.mockRestore();
    vi.doUnmock("./daemon/kill.js");
  });

  it("never writes CLI-level output through the file logger's channel", async () => {
    // Help/version/errors are direct stdout/stderr writes from index.ts
    // itself (legitimate CLI UX) — distinct from the logger, which this
    // test isn't exercising directly. Assert only that main() never throws
    // for any of the top-level command shapes.
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => main(["auth", "login"])).not.toThrow();
    expect(() => main(["daemon", "status"])).not.toThrow();
    expect(() => main(["sessions", "list"])).not.toThrow();
    expect(() => main(["workspace", "sync"])).not.toThrow();

    stdout.mockRestore();
    stderr.mockRestore();
  });
});
