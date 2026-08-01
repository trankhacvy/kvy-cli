import { describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({ execFile: (...args: unknown[]) => execFileMock(...args) }));

const readlinkMock = vi.fn();
vi.mock("node:fs/promises", () => ({ readlink: (...args: unknown[]) => readlinkMock(...args) }));

const { listProcesses, parsePsOutput, resolveProcessCwd } = await import("./processScan.js");

describe("parsePsOutput", () => {
  it("parses a realistic `ps -axo pid=,ppid=,command=` transcript", () => {
    const fixture = [
      "    1     0 /sbin/launchd",
      "  501     1 /usr/sbin/syslogd",
      " 4242     1 node /Users/dev/kvy/packages/cli/dist/index.mjs daemon start-sync",
      " 4300  4242 kvy claude --starting-mode remote --started-by daemon",
    ].join("\n");

    expect(parsePsOutput(fixture)).toEqual([
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 501, ppid: 1, command: "/usr/sbin/syslogd" },
      {
        pid: 4242,
        ppid: 1,
        command: "node /Users/dev/kvy/packages/cli/dist/index.mjs daemon start-sync",
      },
      {
        pid: 4300,
        ppid: 4242,
        command: "kvy claude --starting-mode remote --started-by daemon",
      },
    ]);
  });

  it("skips blank lines and lines that don't start with pid/ppid", () => {
    const fixture = "\n  \n  99    1  kvy kill all\n garbage line without leading numbers\n";
    expect(parsePsOutput(fixture)).toEqual([{ pid: 99, ppid: 1, command: "kvy kill all" }]);
  });

  it("returns an empty array for empty output", () => {
    expect(parsePsOutput("")).toEqual([]);
  });
});

describe("listProcesses", () => {
  it("parses stdout from the mocked ps invocation", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, "  10   1  kvy daemon start-sync\n", "");
    });

    const result = await listProcesses();
    expect(result).toEqual([{ pid: 10, ppid: 1, command: "kvy daemon start-sync" }]);
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

describe("resolveProcessCwd", () => {
  it("reads /proc/<pid>/cwd on linux", async () => {
    readlinkMock.mockResolvedValueOnce("/home/dev/project");
    await expect(resolveProcessCwd(4242, "linux")).resolves.toBe("/home/dev/project");
    expect(readlinkMock).toHaveBeenCalledWith("/proc/4242/cwd");
  });

  it("resolves null on linux when the pid is gone", async () => {
    readlinkMock.mockRejectedValueOnce(new Error("ENOENT"));
    await expect(resolveProcessCwd(4242, "linux")).resolves.toBeNull();
  });

  it("parses `lsof -a -d cwd -p <pid> -Fn` output on darwin", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, "p4242\nfcwd\nn/Users/dev/project\n", "");
    });
    await expect(resolveProcessCwd(4242, "darwin")).resolves.toBe("/Users/dev/project");
    expect(execFileMock).toHaveBeenCalledWith(
      "lsof",
      ["-a", "-d", "cwd", "-p", "4242", "-Fn"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("resolves null on darwin when lsof fails (pid gone, not installed, etc)", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(new Error("lsof: command not found"), "", "");
    });
    await expect(resolveProcessCwd(4242, "darwin")).resolves.toBeNull();
  });

  it("resolves null on an unsupported platform", async () => {
    await expect(resolveProcessCwd(4242, "win32")).resolves.toBeNull();
  });
});
