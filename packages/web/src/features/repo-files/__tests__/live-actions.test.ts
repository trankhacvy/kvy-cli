import { describe, expect, it, vi } from "vitest";
import type { MachineRpcClient } from "@/sync/machineRpc";
import { machineRpcToRepoFilesActions } from "../live-actions";

function fakeRpc(call: MachineRpcClient["call"]): MachineRpcClient {
  return { call };
}

describe("machineRpcToRepoFilesActions", () => {
  it("fetchFileList calls git.files with the given worktree and returns just the file array", async () => {
    const call = vi.fn(async () => ({ files: ["README.md", "src/a.ts"] }));
    const actions = machineRpcToRepoFilesActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.fetchFileList("/repo");

    expect(result).toEqual(["README.md", "src/a.ts"]);
    expect(call).toHaveBeenCalledWith("git.files", expect.objectContaining({ worktree: "/repo" }));
  });

  it("fetchFileContent calls fs.read with worktree/path and maps the result", async () => {
    const call = vi.fn(async () => ({ inline: "const a = 1;\n", truncated: false }));
    const actions = machineRpcToRepoFilesActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.fetchFileContent("/repo", "src/a.ts");

    expect(result).toEqual({ inline: "const a = 1;\n", blobRef: undefined, truncated: false });
    expect(call).toHaveBeenCalledWith(
      "fs.read",
      expect.objectContaining({ worktree: "/repo", path: "src/a.ts" }),
    );
  });

  it("fetchFileContent surfaces truncated: true files with a blobRef unchanged", async () => {
    const call = vi.fn(async () => ({
      inline: "partial content",
      truncated: true,
      blobRef: "blob-1",
    }));
    const actions = machineRpcToRepoFilesActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.fetchFileContent("/repo", "big.txt");
    expect(result).toEqual({ inline: "partial content", truncated: true, blobRef: "blob-1" });
  });
});
