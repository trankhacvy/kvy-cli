import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWorkspace, unregisterWorkspace } from "./workspaceRegisterRpc.js";

/**
 * Unit-level coverage for the `workspace.register` RPC's backing module,
 * matching the sibling wrapper convention (`fsBrowse.test.ts`,
 * `gitStatus.test.ts`, `gitDiff.test.ts`) — one dedicated test file per
 * RPC-backing module, distinct from `machineRpc.test.ts`'s own coverage of
 * the RPC envelope (schema validation, encryption, dispatch). This isolates
 * `workspaceRegisterRpc.ts`'s own delegation to the real
 * `workspace/registry.ts`'s `registerWorkspace` from that envelope, the same
 * way `fsBrowse.test.ts` tests `createDirectory`/`listDirectory` directly
 * rather than only through `machineRpc.test.ts`.
 *
 * Uses `KVY_HOME_DIR` (not an injected options param — `registerWorkspace`
 * here intentionally takes no such seam, same "real, dependency-free
 * default" contract as `fs.list`/`fs.mkdir`) to isolate each test's
 * `workspaces.json` from the real `~/.kvy`, same technique
 * `machineRpc.test.ts`'s "with the real default" block already uses.
 */
describe("registerWorkspace (workspace.register RPC backing module)", () => {
  let homeDir: string;
  let previousKvyHomeDir: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-workspace-register-rpc-unit-"));
    previousKvyHomeDir = process.env.KVY_HOME_DIR;
    process.env.KVY_HOME_DIR = homeDir;
  });

  afterEach(async () => {
    if (previousKvyHomeDir === undefined) delete process.env.KVY_HOME_DIR;
    else process.env.KVY_HOME_DIR = previousKvyHomeDir;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("delegates to the real registry, writing a workspaces.json entry, and returns {ok: true}", async () => {
    const target = path.join(homeDir, "fresh-project");

    const result = await registerWorkspace({ idempotencyKey: "idem-1", directory: target });

    expect(result).toEqual({ ok: true });
    const written = JSON.parse(await readFile(path.join(homeDir, "workspaces.json"), "utf8"));
    expect(written.workspaces).toContainEqual(expect.objectContaining({ path: target }));
  });

  it("is idempotent: registering the same directory twice doesn't duplicate the entry", async () => {
    const target = path.join(homeDir, "again");

    await registerWorkspace({ idempotencyKey: "idem-2", directory: target });
    await registerWorkspace({ idempotencyKey: "idem-3", directory: target });

    const written = JSON.parse(await readFile(path.join(homeDir, "workspaces.json"), "utf8"));
    const matches = written.workspaces.filter((entry: { path: string }) => entry.path === target);
    expect(matches).toHaveLength(1);
  });
});

describe("unregisterWorkspace (workspace.unregister RPC backing module)", () => {
  let homeDir: string;
  let previousKvyHomeDir: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-workspace-unregister-rpc-unit-"));
    previousKvyHomeDir = process.env.KVY_HOME_DIR;
    process.env.KVY_HOME_DIR = homeDir;
  });

  afterEach(async () => {
    if (previousKvyHomeDir === undefined) delete process.env.KVY_HOME_DIR;
    else process.env.KVY_HOME_DIR = previousKvyHomeDir;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("removes a previously-registered directory's entry and returns {ok: true}", async () => {
    const target = path.join(homeDir, "stale-project");
    await registerWorkspace({ idempotencyKey: "idem-1", directory: target });

    const result = await unregisterWorkspace({ idempotencyKey: "idem-2", directory: target });

    expect(result).toEqual({ ok: true });
    const written = JSON.parse(await readFile(path.join(homeDir, "workspaces.json"), "utf8"));
    expect(written.workspaces).not.toContainEqual(expect.objectContaining({ path: target }));
  });

  it("is idempotent: unregistering a directory that was never registered is a safe no-op", async () => {
    const target = path.join(homeDir, "never-registered");
    await expect(
      unregisterWorkspace({ idempotencyKey: "idem-3", directory: target }),
    ).resolves.toEqual({ ok: true });
  });
});
