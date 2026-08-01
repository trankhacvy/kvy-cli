import { describe, expect, it } from "vitest";
import { classifyKvyCommand, classifyProcesses } from "./markers.js";
import type { ProcessEntry } from "./processScan.js";

describe("classifyKvyCommand", () => {
  it("classifies the built daemon process (production entrypoint)", () => {
    expect(
      classifyKvyCommand("node /Users/dev/kvy/packages/cli/dist/index.mjs daemon start-sync"),
    ).toEqual({ kind: "daemon", spawnedByDaemon: false });
  });

  it("classifies the dev (tsx) daemon process", () => {
    expect(
      classifyKvyCommand("node /Users/dev/kvy/packages/cli/src/index.ts daemon start"),
    ).toEqual({ kind: "daemon", spawnedByDaemon: false });
  });

  it("classifies a bare installed-binary daemon invocation", () => {
    expect(classifyKvyCommand("kvy daemon start-sync")).toEqual({
      kind: "daemon",
      spawnedByDaemon: false,
    });
  });

  it("classifies `daemon stop`/`daemon status` as administrative, not daemon", () => {
    expect(classifyKvyCommand("kvy daemon stop")).toEqual({
      kind: "other",
      spawnedByDaemon: false,
    });
    expect(classifyKvyCommand("kvy daemon status")).toEqual({
      kind: "other",
      spawnedByDaemon: false,
    });
  });

  it("classifies a daemon-spawned remote session as a session, flagged spawnedByDaemon", () => {
    expect(classifyKvyCommand("kvy claude --starting-mode remote --started-by daemon")).toEqual({
      kind: "session",
      spawnedByDaemon: true,
    });
  });

  it("classifies an ordinary local-mode session (bare kvy, claude, codex)", () => {
    expect(classifyKvyCommand("kvy")).toEqual({ kind: "session", spawnedByDaemon: false });
    expect(classifyKvyCommand("kvy claude --resume abc123")).toEqual({
      kind: "session",
      spawnedByDaemon: false,
    });
    expect(classifyKvyCommand("kvy codex")).toEqual({
      kind: "session",
      spawnedByDaemon: false,
    });
  });

  it("classifies kvy's own administrative subcommands as `other`", () => {
    for (const cmd of [
      "kvy kill all",
      "kvy auth login",
      "kvy sessions list",
      "kvy resume abc123",
      "kvy workspace sync",
      "kvy notify -p hi",
      "kvy --help",
      "kvy --version",
      "kvy doctor",
      "kvy doctor clean",
    ]) {
      expect(classifyKvyCommand(cmd)).toEqual({ kind: "other", spawnedByDaemon: false });
    }
  });

  it("classifies a session started via the dev/prod node entrypoint the same as a bare `kvy` invocation", () => {
    expect(
      classifyKvyCommand("node /Users/dev/kvy/packages/cli/dist/index.mjs claude --resume abc123"),
    ).toEqual({ kind: "session", spawnedByDaemon: false });
    expect(classifyKvyCommand("node /Users/dev/kvy/packages/cli/src/index.ts codex")).toEqual({
      kind: "session",
      spawnedByDaemon: false,
    });
  });

  it("returns null for processes unrelated to Kvy", () => {
    expect(classifyKvyCommand("/sbin/launchd")).toBeNull();
    expect(classifyKvyCommand("node /Users/dev/some-other-app/server.js")).toBeNull();
    expect(classifyKvyCommand("/usr/bin/ssh-agent -l")).toBeNull();
  });

  it("does not false-positive on a command that merely contains the substring 'kvy'", () => {
    // e.g. a user's own unrelated project named "kvyry" or a path
    // containing "kvy" without the CLI entrypoint token itself.
    expect(classifyKvyCommand("/usr/local/bin/kvyry-server --port 8080")).toBeNull();
  });
});

describe("classifyProcesses", () => {
  const processes: ProcessEntry[] = [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    { pid: 100, ppid: 1, command: "kvy daemon start-sync" },
    { pid: 200, ppid: 100, command: "kvy claude --starting-mode remote --started-by daemon" },
    { pid: 300, ppid: 1, command: "kvy claude --resume abc" },
    { pid: 400, ppid: 1, command: "kvy kill all" }, // the invoking process itself
  ];

  it("filters to Kvy-owned processes and excludes the current pid", () => {
    const result = classifyProcesses(processes, 400);
    expect(result.map((p) => p.pid)).toEqual([100, 200, 300]);
    expect(result.find((p) => p.pid === 100)?.kind).toBe("daemon");
    expect(result.find((p) => p.pid === 200)?.kind).toBe("session");
    expect(result.find((p) => p.pid === 200)?.spawnedByDaemon).toBe(true);
    expect(result.find((p) => p.pid === 300)?.kind).toBe("session");
  });

  it("still excludes non-Kvy processes even when currentPid doesn't match any of them", () => {
    const result = classifyProcesses(processes, 999);
    expect(result.map((p) => p.pid).sort()).toEqual([100, 200, 300, 400]);
  });
});
