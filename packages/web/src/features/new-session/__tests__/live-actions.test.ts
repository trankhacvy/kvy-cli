import { describe, expect, it, vi } from "vitest";
import type { MachineRpcClient } from "@/sync/machineRpc";
import { machineRpcToActions } from "../live-actions";

function fakeRpc(call: MachineRpcClient["call"]): MachineRpcClient {
  return { call };
}

describe("machineRpcToActions", () => {
  it("browseDirectory calls fs.list and returns the result as-is", async () => {
    const call = vi.fn(async () => ({ path: "/home/me", parent: "/home", entries: [] }));
    const actions = machineRpcToActions(fakeRpc(call as unknown as MachineRpcClient["call"]));

    const result = await actions.browseDirectory("/home/me");
    expect(result).toEqual({ path: "/home/me", parent: "/home", entries: [] });
    expect(call).toHaveBeenCalledWith("fs.list", expect.objectContaining({ path: "/home/me" }));
  });

  it("createDirectory calls fs.mkdir", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const actions = machineRpcToActions(fakeRpc(call as unknown as MachineRpcClient["call"]));

    await actions.createDirectory("/tmp/new");
    expect(call).toHaveBeenCalledWith("fs.mkdir", expect.objectContaining({ path: "/tmp/new" }));
  });

  it("spawn maps a sessionId result to a success outcome", async () => {
    const call = vi.fn(async () => ({ sessionId: "sess-1" }));
    const actions = machineRpcToActions(fakeRpc(call as unknown as MachineRpcClient["call"]));

    const outcome = await actions.spawn({
      directory: "/repo",
      provider: "claude-code",
      permissionMode: "default",
    });
    expect(outcome).toEqual({ type: "success", sessionId: "sess-1" });
    expect(call).toHaveBeenCalledWith(
      "spawn",
      expect.objectContaining({ directory: "/repo", workspaceId: "/repo" }),
    );
  });

  it("spawn maps a create-directory requiresApproval result to a requiresApproval outcome", async () => {
    const call = vi.fn(async () => ({
      requiresApproval: { action: "create-directory", directory: "/repo" },
    }));
    const actions = machineRpcToActions(fakeRpc(call as unknown as MachineRpcClient["call"]));

    const outcome = await actions.spawn({
      directory: "/repo",
      provider: "claude-code",
      permissionMode: "default",
    });
    expect(outcome).toEqual({
      type: "requiresApproval",
      action: "create-directory",
      directory: "/repo",
    });
  });

  it("spawn maps a register-workspace requiresApproval result to a requiresApproval outcome (Flow 3 Piece A)", async () => {
    const call = vi.fn(async () => ({
      requiresApproval: { action: "register-workspace", directory: "/fresh/repo" },
    }));
    const actions = machineRpcToActions(fakeRpc(call as unknown as MachineRpcClient["call"]));

    const outcome = await actions.spawn({
      directory: "/fresh/repo",
      provider: "claude-code",
      permissionMode: "default",
    });
    expect(outcome).toEqual({
      type: "requiresApproval",
      action: "register-workspace",
      directory: "/fresh/repo",
    });
  });

  it("registerWorkspace calls workspace.register", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const actions = machineRpcToActions(fakeRpc(call as unknown as MachineRpcClient["call"]));

    await actions.registerWorkspace("/fresh/repo");

    expect(call).toHaveBeenCalledExactlyOnceWith(
      "workspace.register",
      expect.objectContaining({ directory: "/fresh/repo" }),
    );
  });

  it("spawn throws when the result carries neither field", async () => {
    const call = vi.fn(async () => ({}));
    const actions = machineRpcToActions(fakeRpc(call as unknown as MachineRpcClient["call"]));

    await expect(
      actions.spawn({ directory: "/repo", provider: "claude-code", permissionMode: "default" }),
    ).rejects.toThrow(/neither/);
  });

  it("spawn forwards continueFrom when an import candidate was picked", async () => {
    const call = vi.fn(async () => ({ sessionId: "sess-1" }));
    const actions = machineRpcToActions(fakeRpc(call as unknown as MachineRpcClient["call"]));

    await actions.spawn({
      directory: "/repo",
      provider: "claude-code",
      permissionMode: "default",
      continueFrom: { providerSessionId: "prov-1" },
    });
    expect(call).toHaveBeenCalledWith(
      "spawn",
      expect.objectContaining({ continueFrom: { providerSessionId: "prov-1" } }),
    );
  });

  it("listImportCandidates calls adopt.list with the directory as workspaceId and returns the items", async () => {
    const items = [{ providerSessionId: "prov-1", lastActivityAt: 1_000, running: true }];
    const call = vi.fn(async () => ({ items }));
    const actions = machineRpcToActions(fakeRpc(call as unknown as MachineRpcClient["call"]));

    const result = await actions.listImportCandidates("/repo");
    expect(result).toEqual(items);
    expect(call).toHaveBeenCalledWith(
      "adopt.list",
      expect.objectContaining({ workspaceId: "/repo" }),
    );
  });

  it("listBranches calls git.branches with the directory as worktree and returns the branches", async () => {
    const branches = [
      { name: "main", isCurrent: true },
      { name: "wf/foo", isCurrent: false, checkedOutAt: "/repo/.worktrees/wf/foo" },
    ];
    const call = vi.fn(async () => ({ branches }));
    const actions = machineRpcToActions(fakeRpc(call as unknown as MachineRpcClient["call"]));

    const result = await actions.listBranches("/repo");
    expect(result).toEqual(branches);
    expect(call).toHaveBeenCalledWith(
      "git.branches",
      expect.objectContaining({ worktree: "/repo" }),
    );
  });
});
