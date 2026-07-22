import { describe, expect, it, vi } from "vitest";
import type { MachineRpcClient } from "@/sync/machineRpc";
import { createFsFileMentionActions } from "../live-actions";

function fakeRpc(call: MachineRpcClient["call"]): MachineRpcClient {
  return { call };
}

describe("createFsFileMentionActions", () => {
  it("walks the directory tree via fs.list and returns fuzzy-filtered repo-relative paths", async () => {
    const call = vi.fn(async (_method: string, params: { path?: string }) => {
      if (params.path === "/repo") {
        return {
          path: "/repo",
          parent: "/",
          entries: [
            { name: "CLAUDE.md", isDirectory: false },
            { name: "package.json", isDirectory: false },
            { name: "packages", isDirectory: true },
            { name: "node_modules", isDirectory: true },
            { name: ".git", isDirectory: true },
          ],
        };
      }
      if (params.path === "/repo/packages") {
        return {
          path: "/repo/packages",
          parent: "/repo",
          entries: [{ name: "wire", isDirectory: true }],
        };
      }
      if (params.path === "/repo/packages/wire") {
        return {
          path: "/repo/packages/wire",
          parent: "/repo/packages",
          entries: [{ name: "package.json", isDirectory: false }],
        };
      }
      throw new Error(
        `unexpected fs.list call for ${params.path} (node_modules/.git must not be descended into)`,
      );
    });

    const actions = createFsFileMentionActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
      "/repo",
    );

    const results = await actions.search("package.json");

    expect(results.map((r) => r.path)).toEqual(["package.json", "packages/wire/package.json"]);
    // Confirms node_modules/.git were never listed (the mock throws if they were).
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("returns an empty result rather than throwing when a directory can't be listed", async () => {
    const call = vi.fn(async () => {
      throw new Error("permission denied");
    });
    const actions = createFsFileMentionActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
      "/repo",
    );

    await expect(actions.search("anything")).resolves.toEqual([]);
  });

  it("passes an idempotencyKey with each fs.list call", async () => {
    const call = vi.fn(async () => ({ path: "/repo", parent: null, entries: [] }));
    const actions = createFsFileMentionActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
      "/repo",
    );

    await actions.search("");

    expect(call).toHaveBeenCalledWith(
      "fs.list",
      expect.objectContaining({ path: "/repo", idempotencyKey: expect.any(String) }),
    );
  });
});
