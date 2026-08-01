import type { EncryptedBox } from "@kvy/wire";
import { describe, expect, it, vi } from "vitest";
import type { ApiSocket, RpcCallResult } from "../apiSocket.js";
import { createMachineRpcClient, type MachineRpcCrypto, MachineRpcError } from "../machineRpc.js";

const box = (payload: unknown): EncryptedBox => ({ t: "enc", v: 1, c: JSON.stringify(payload) });

function fakeCrypto(openOverride?: (box: EncryptedBox) => unknown): MachineRpcCrypto {
  return {
    async seal(data) {
      return box(data);
    },
    async open<T>(b: EncryptedBox) {
      if (openOverride) return openOverride(b) as T;
      return JSON.parse(b.c) as T;
    },
  };
}

function fakeSocket(
  rpcCall: (target: string, method: string, params: EncryptedBox) => Promise<RpcCallResult>,
): Pick<ApiSocket, "rpcCall"> {
  return { rpcCall };
}

describe("createMachineRpcClient", () => {
  it("targets 'm:<machineId>:<method>' and seals params under the given crypto client", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({ sessionId: "sess-1" }),
      }),
    );
    const client = createMachineRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      machineId: "mach-42",
    });

    await client.call("spawn", {
      idempotencyKey: "idem-1",
      workspaceId: "/repo",
      directory: "/repo",
      provider: "claude-code",
      permissionMode: "default",
    });

    expect(rpcCall).toHaveBeenCalledTimes(1);
    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-42:spawn",
      "spawn",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
  });

  it("returns the decrypted, schema-validated spawn result on success", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ sessionId: "sess-1" }) })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("spawn", {
      idempotencyKey: "idem-1",
      workspaceId: "/repo",
      directory: "/repo",
      provider: "claude-code",
      permissionMode: "default",
    });

    expect(result).toEqual({ sessionId: "sess-1" });
  });

  it("returns a requiresApproval spawn result normally (does not throw)", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ requiresApproval: { action: "create-directory", directory: "/x" } }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("spawn", {
      idempotencyKey: "idem-1",
      workspaceId: "/x",
      directory: "/x",
      provider: "claude-code",
      permissionMode: "default",
    });

    expect(result).toEqual({
      requiresApproval: { action: "create-directory", directory: "/x" },
    });
  });

  it("round-trips an fs.list call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ path: "/home/me", parent: "/home", entries: [] }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("fs.list", { idempotencyKey: "idem-2" });
    expect(result).toEqual({ path: "/home/me", parent: "/home", entries: [] });
  });

  it("round-trips an fs.mkdir call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ ok: true }) })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("fs.mkdir", { idempotencyKey: "idem-3", path: "/tmp/x" });
    expect(result).toEqual({ ok: true });
  });

  it("round-trips a workspace.register call and result (Flow 3 Piece A)", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ ok: true }) })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("workspace.register", {
      idempotencyKey: "idem-ws-1",
      directory: "/fresh/repo",
    });
    expect(result).toEqual({ ok: true });
  });

  it("round-trips an adopt.list call and result", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({ items: [{ providerSessionId: "prov-1", lastActivityAt: 1_000 }] }),
      }),
    );
    const client = createMachineRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("adopt.list", {
      idempotencyKey: "idem-list",
      workspaceId: "/repo",
    });

    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-1:adopt.list",
      "adopt.list",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    expect(result).toEqual({ items: [{ providerSessionId: "prov-1", lastActivityAt: 1_000 }] });
  });

  it("round-trips a resumeSession call and result (docs/features/session-lifecycle-actions.md Phase 6 — Restart)", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({ ok: true }),
      }),
    );
    const client = createMachineRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("resumeSession", { sessionId: "sess-1" });

    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-1:resumeSession",
      "resumeSession",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("surfaces resumeSession's handler-error verbatim (e.g. a session not in the daemon's durable registry)", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ ok: false, error: "session sess-1 is not tracked by this daemon" }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    await expect(client.call("resumeSession", { sessionId: "sess-1" })).rejects.toThrow(
      "session sess-1 is not tracked by this daemon",
    );
  });

  it("surfaces the daemon's typed .code as handlerErrorCode on MachineRpcError (known-issues.md #3)", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({
          ok: false,
          error: "workspace directory not found: /gone",
          code: "workspace-missing",
        }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    await expect(
      client.call("git.status", { idempotencyKey: "idem-ws-1", worktree: "/gone" }),
    ).rejects.toMatchObject({
      name: "MachineRpcError",
      message: "workspace directory not found: /gone",
      code: "handler-error",
      handlerErrorCode: "workspace-missing",
    });
  });

  it("leaves handlerErrorCode undefined for a plain handler error with no .code (e.g. an ordinary git failure)", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ ok: false, error: "fatal: not a git repository" }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    await expect(
      client.call("git.status", { idempotencyKey: "idem-ws-2", worktree: "/repo" }),
    ).rejects.toMatchObject({
      name: "MachineRpcError",
      handlerErrorCode: undefined,
    });
  });

  it("round-trips an adopt.take call and result", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({ sessionId: "sess-new", warning: "mid-turn interrupt" }),
      }),
    );
    const client = createMachineRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("adopt.take", {
      idempotencyKey: "idem-4",
      providerSessionId: "prov-1",
      mode: "takeover",
    });

    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-1:adopt.take",
      "adopt.take",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    expect(result).toEqual({ sessionId: "sess-new", warning: "mid-turn interrupt" });
  });

  it("round-trips an adopt.mirror call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ chunk: "hello", nextCursor: 5, done: false }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("adopt.mirror", {
      idempotencyKey: "idem-5",
      providerSessionId: "prov-1",
      cursor: 0,
    });

    expect(result).toEqual({ chunk: "hello", nextCursor: 5, done: false });
  });

  it("round-trips a git.status call and result", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({
          branch: "main",
          ahead: 1,
          behind: 0,
          files: [{ path: "src/a.ts", status: "modified" }],
        }),
      }),
    );
    const client = createMachineRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("git.status", {
      idempotencyKey: "idem-6",
      worktree: "/repo",
    });

    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-1:git.status",
      "git.status",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    expect(result).toEqual({
      branch: "main",
      ahead: 1,
      behind: 0,
      files: [{ path: "src/a.ts", status: "modified" }],
    });
  });

  it("round-trips a git.diff call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ inline: "diff --git a/x b/x", truncated: false }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("git.diff", {
      idempotencyKey: "idem-7",
      worktree: "/repo",
      baseRef: "main",
    });

    expect(result).toEqual({ inline: "diff --git a/x b/x", truncated: false });
  });

  it("round-trips a git.files call and result", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({ files: ["README.md", "src/a.ts"] }),
      }),
    );
    const client = createMachineRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("git.files", {
      idempotencyKey: "idem-8",
      worktree: "/repo",
    });

    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-1:git.files",
      "git.files",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    expect(result).toEqual({ files: ["README.md", "src/a.ts"] });
  });

  it("round-trips an fs.read call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ inline: "const a = 1;\n", truncated: false }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("fs.read", {
      idempotencyKey: "idem-9",
      worktree: "/repo",
      path: "src/a.ts",
    });

    expect(result).toEqual({ inline: "const a = 1;\n", truncated: false });
  });

  it("round-trips a preview.ports call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({
          cloudflared: { installed: true, version: "2024.6.1" },
          ports: [{ port: 3000, address: "*", pid: 42, processName: "node" }],
        }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("preview.ports", { idempotencyKey: "idem-10" });

    expect(result).toEqual({
      cloudflared: { installed: true, version: "2024.6.1" },
      ports: [{ port: 3000, address: "*", pid: 42, processName: "node" }],
    });
  });

  it("round-trips a preview.tunnels call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({
          tunnels: [
            {
              tunnelId: "t1",
              port: 3000,
              url: "https://t1.trycloudflare.com",
              status: "active",
              startedAt: 1000,
            },
          ],
        }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("preview.tunnels", { idempotencyKey: "idem-11" });

    expect(result).toEqual({
      tunnels: [
        {
          tunnelId: "t1",
          port: 3000,
          url: "https://t1.trycloudflare.com",
          status: "active",
          startedAt: 1000,
        },
      ],
    });
  });

  it("round-trips a preview.open call and result", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({ tunnelId: "t1", url: "https://t1.trycloudflare.com", port: 3000 }),
      }),
    );
    const client = createMachineRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("preview.open", { idempotencyKey: "idem-12", port: 3000 });

    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-1:preview.open",
      "preview.open",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    expect(result).toEqual({ tunnelId: "t1", url: "https://t1.trycloudflare.com", port: 3000 });
  });

  it("round-trips a preview.close call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ ok: true }) })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("preview.close", {
      idempotencyKey: "idem-13",
      tunnelId: "t1",
    });

    expect(result).toEqual({ ok: true });
  });

  it("round-trips a workspace.getConfig call and result (docs/features/setup-run-scripts.md)", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({
          baseRef: "main",
          remote: "origin",
          setupScript: "npm install",
          runScript: "npm run dev",
        }),
      }),
    );
    const client = createMachineRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("workspace.getConfig", {
      idempotencyKey: "idem-10",
      worktree: "/repo",
    });

    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-1:workspace.getConfig",
      "workspace.getConfig",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    expect(result).toEqual({
      baseRef: "main",
      remote: "origin",
      setupScript: "npm install",
      runScript: "npm run dev",
    });
  });

  it("round-trips a run.start call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ started: true, method: "tmux", pid: 555, tmuxSessionName: "kvy-run-x" }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("run.start", {
      idempotencyKey: "idem-11",
      worktree: "/repo",
    });

    expect(result).toEqual({
      started: true,
      method: "tmux",
      pid: 555,
      tmuxSessionName: "kvy-run-x",
    });
  });

  it("round-trips a run.status call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({
          run: { state: "running", pid: 1, method: "tmux", startedAt: 1, logTail: "listening\n" },
          setup: { state: "succeeded", exitCode: 0, startedAt: 1, finishedAt: 2 },
        }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("run.status", {
      idempotencyKey: "idem-12",
      worktree: "/repo",
    });

    expect(result).toEqual({
      run: { state: "running", pid: 1, method: "tmux", startedAt: 1, logTail: "listening\n" },
      setup: { state: "succeeded", exitCode: 0, startedAt: 1, finishedAt: 2 },
    });
  });

  it("round-trips a run.stop call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ stopped: true, wasRunning: true }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("run.stop", { idempotencyKey: "idem-13", worktree: "/repo" });
    expect(result).toEqual({ stopped: true, wasRunning: true });
  });

  it("round-trips a run.setup call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ started: true }) })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("run.setup", { idempotencyKey: "idem-14", worktree: "/repo" });
    expect(result).toEqual({ started: true });
  });

  it("throws MachineRpcError when the transport reports failure", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({ ok: false, error: "target-offline" })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    await expect(client.call("fs.list", { idempotencyKey: "idem-1" })).rejects.toThrow(
      MachineRpcError,
    );
    await expect(client.call("fs.list", { idempotencyKey: "idem-1" })).rejects.toThrow(
      "target-offline",
    );
  });

  it("throws MachineRpcError with the daemon handler's own message (not a generic schema-validation error) when the daemon replies with a sealed {ok:false,error} box", async () => {
    // Reproduces the daemon's `onRpcRequest` catch path (`daemon/machineRpc.ts`):
    // a thrown `GitExecError`/`Error` is sealed as `{ok:false, error: <message>}`,
    // which structurally can never satisfy a real result schema — this must be
    // special-cased BEFORE schema validation, or the caller only ever sees a
    // useless "'method' RPC result failed schema validation" instead of the
    // actual git stderr (docs/features/git-write-actions.md's credential-failure
    // UX depends on this).
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ ok: false, error: "fatal: could not read Username for 'https://...'" }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    await expect(
      client.call("git.push", { idempotencyKey: "idem-8", worktree: "/repo" }),
    ).rejects.toThrow("fatal: could not read Username for 'https://...'");
  });

  it("round-trips sleepInhibit.get and sleepInhibit.set calls and results (docs/features/sleep-inhibit.md)", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({ supported: true, platform: "darwin", mode: "always", active: true }),
      }),
    );
    const client = createMachineRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const getResult = await client.call("sleepInhibit.get", { idempotencyKey: "idem-9" });
    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-1:sleepInhibit.get",
      "sleepInhibit.get",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    expect(getResult).toEqual({
      supported: true,
      platform: "darwin",
      mode: "always",
      active: true,
    });

    const setResult = await client.call("sleepInhibit.set", {
      idempotencyKey: "idem-10",
      mode: "always",
    });
    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-1:sleepInhibit.set",
      "sleepInhibit.set",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    expect(setResult).toEqual({
      supported: true,
      platform: "darwin",
      mode: "always",
      active: true,
    });
  });

  it("throws MachineRpcError when the sealed result fails to decrypt", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ ok: true }) })),
      crypto: fakeCrypto(() => null),
      machineId: "mach-1",
    });

    await expect(client.call("fs.mkdir", { idempotencyKey: "idem-1", path: "/x" })).rejects.toThrow(
      /decrypt/,
    );
  });

  it("throws MachineRpcError when the decrypted result fails schema validation", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ garbage: 1 }) })),
      crypto: fakeCrypto(() => ({ garbage: 1 })),
      machineId: "mach-1",
    });

    await expect(client.call("fs.mkdir", { idempotencyKey: "idem-1", path: "/x" })).rejects.toThrow(
      /schema validation/,
    );
  });
});
