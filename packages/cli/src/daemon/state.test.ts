import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonStatePath, readDaemonState, writeDaemonState } from "./state.js";

describe("daemon state", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-daemon-state-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("returns null when no state file exists yet", async () => {
    expect(await readDaemonState(homeDir)).toBeNull();
  });

  it("round-trips a written state", async () => {
    const state = { pid: 1234, port: 4567, version: "0.1.0", startedAt: 1_700_000_000_000 };
    await writeDaemonState(homeDir, state);
    expect(await readDaemonState(homeDir)).toEqual(state);
  });

  it("creates homeDir if it does not exist yet", async () => {
    const nested = path.join(homeDir, "nested", "dir");
    const state = { pid: 1, port: 2, version: "0.0.1", startedAt: 0 };
    await writeDaemonState(nested, state);
    expect(await readDaemonState(nested)).toEqual(state);
  });

  it("treats a corrupt state file as absent", async () => {
    await writeFile(daemonStatePath(homeDir), "{not valid json", "utf8");
    expect(await readDaemonState(homeDir)).toBeNull();
  });

  it("treats a well-formed-JSON-but-wrong-shape file as absent", async () => {
    await writeFile(daemonStatePath(homeDir), JSON.stringify({ pid: 1 }), "utf8");
    expect(await readDaemonState(homeDir)).toBeNull();
  });
});
