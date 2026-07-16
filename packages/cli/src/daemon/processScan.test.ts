import { describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({ execFile: (...args: unknown[]) => execFileMock(...args) }));

const { listProcesses, parsePsOutput } = await import("./processScan.js");

describe("parsePsOutput", () => {
  it("parses a realistic `ps -axo pid=,ppid=,command=` transcript", () => {
    const fixture = [
      "    1     0 /sbin/launchd",
      "  501     1 /usr/sbin/syslogd",
      " 4242     1 node /Users/dev/falcon/packages/cli/dist/index.mjs daemon start-sync",
      " 4300  4242 falcon claude --starting-mode remote --started-by daemon",
    ].join("\n");

    expect(parsePsOutput(fixture)).toEqual([
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 501, ppid: 1, command: "/usr/sbin/syslogd" },
      {
        pid: 4242,
        ppid: 1,
        command: "node /Users/dev/falcon/packages/cli/dist/index.mjs daemon start-sync",
      },
      {
        pid: 4300,
        ppid: 4242,
        command: "falcon claude --starting-mode remote --started-by daemon",
      },
    ]);
  });

  it("skips blank lines and lines that don't start with pid/ppid", () => {
    const fixture = "\n  \n  99    1  falcon kill all\n garbage line without leading numbers\n";
    expect(parsePsOutput(fixture)).toEqual([{ pid: 99, ppid: 1, command: "falcon kill all" }]);
  });

  it("returns an empty array for empty output", () => {
    expect(parsePsOutput("")).toEqual([]);
  });
});

describe("listProcesses", () => {
  it("parses stdout from the mocked ps invocation", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, "  10   1  falcon daemon start-sync\n", "");
    });

    const result = await listProcesses();
    expect(result).toEqual([{ pid: 10, ppid: 1, command: "falcon daemon start-sync" }]);
    expect(execFileMock).toHaveBeenCalledWith(
      "ps",
      ["-axo", "pid=,ppid=,command="],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns an empty array instead of throwing when `ps` fails", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(new Error("ps: command not found"), "", "");
    });

    await expect(listProcesses()).resolves.toEqual([]);
  });
});
