import { describe, expect, it } from "vitest";
import { classifyFalconCommand, classifyProcesses } from "./markers.js";
import type { ProcessEntry } from "./processScan.js";

describe("classifyFalconCommand", () => {
  it("classifies the built daemon process (production entrypoint)", () => {
    expect(
      classifyFalconCommand("node /Users/dev/falcon/packages/cli/dist/index.mjs daemon start-sync"),
    ).toEqual({ kind: "daemon", spawnedByDaemon: false });
  });

  it("classifies the dev (tsx) daemon process", () => {
    expect(
      classifyFalconCommand("node /Users/dev/falcon/packages/cli/src/index.ts daemon start"),
    ).toEqual({ kind: "daemon", spawnedByDaemon: false });
  });

  it("classifies a bare installed-binary daemon invocation", () => {
    expect(classifyFalconCommand("falcon daemon start-sync")).toEqual({
      kind: "daemon",
      spawnedByDaemon: false,
    });
  });

  it("classifies `daemon stop`/`daemon status` as administrative, not daemon", () => {
    expect(classifyFalconCommand("falcon daemon stop")).toEqual({
      kind: "other",
      spawnedByDaemon: false,
    });
    expect(classifyFalconCommand("falcon daemon status")).toEqual({
      kind: "other",
      spawnedByDaemon: false,
    });
  });

  it("classifies a daemon-spawned remote session as a session, flagged spawnedByDaemon", () => {
    expect(
      classifyFalconCommand("falcon claude --starting-mode remote --started-by daemon"),
    ).toEqual({ kind: "session", spawnedByDaemon: true });
  });

  it("classifies an ordinary local-mode session (bare falcon, claude, codex)", () => {
    expect(classifyFalconCommand("falcon")).toEqual({ kind: "session", spawnedByDaemon: false });
    expect(classifyFalconCommand("falcon claude --resume abc123")).toEqual({
      kind: "session",
      spawnedByDaemon: false,
    });
    expect(classifyFalconCommand("falcon codex")).toEqual({
      kind: "session",
      spawnedByDaemon: false,
    });
  });

  it("classifies falcon's own administrative subcommands as `other`", () => {
    for (const cmd of [
      "falcon kill all",
      "falcon auth login",
      "falcon sessions list",
      "falcon resume abc123",
      "falcon workspace sync",
      "falcon notify -p hi",
      "falcon --help",
      "falcon --version",
    ]) {
      expect(classifyFalconCommand(cmd)).toEqual({ kind: "other", spawnedByDaemon: false });
    }
  });

  it("classifies a session started via the dev/prod node entrypoint the same as a bare `falcon` invocation", () => {
    expect(
      classifyFalconCommand(
        "node /Users/dev/falcon/packages/cli/dist/index.mjs claude --resume abc123",
      ),
    ).toEqual({ kind: "session", spawnedByDaemon: false });
    expect(classifyFalconCommand("node /Users/dev/falcon/packages/cli/src/index.ts codex")).toEqual(
      { kind: "session", spawnedByDaemon: false },
    );
  });

  it("returns null for processes unrelated to Falcon", () => {
    expect(classifyFalconCommand("/sbin/launchd")).toBeNull();
    expect(classifyFalconCommand("node /Users/dev/some-other-app/server.js")).toBeNull();
    expect(classifyFalconCommand("/usr/bin/ssh-agent -l")).toBeNull();
  });

  it("does not false-positive on a command that merely contains the substring 'falcon'", () => {
    // e.g. a user's own unrelated project named "falconry" or a path
    // containing "falcon" without the CLI entrypoint token itself.
    expect(classifyFalconCommand("/usr/local/bin/falconry-server --port 8080")).toBeNull();
  });
});

describe("classifyProcesses", () => {
  const processes: ProcessEntry[] = [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    { pid: 100, ppid: 1, command: "falcon daemon start-sync" },
    { pid: 200, ppid: 100, command: "falcon claude --starting-mode remote --started-by daemon" },
    { pid: 300, ppid: 1, command: "falcon claude --resume abc" },
    { pid: 400, ppid: 1, command: "falcon kill all" }, // the invoking process itself
  ];

  it("filters to Falcon-owned processes and excludes the current pid", () => {
    const result = classifyProcesses(processes, 400);
    expect(result.map((p) => p.pid)).toEqual([100, 200, 300]);
    expect(result.find((p) => p.pid === 100)?.kind).toBe("daemon");
    expect(result.find((p) => p.pid === 200)?.kind).toBe("session");
    expect(result.find((p) => p.pid === 200)?.spawnedByDaemon).toBe(true);
    expect(result.find((p) => p.pid === 300)?.kind).toBe("session");
  });

  it("still excludes non-Falcon processes even when currentPid doesn't match any of them", () => {
    const result = classifyProcesses(processes, 999);
    expect(result.map((p) => p.pid).sort()).toEqual([100, 200, 300, 400]);
  });
});
