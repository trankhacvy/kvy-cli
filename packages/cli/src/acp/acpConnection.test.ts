import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADAPTER_MANIFEST, adapterEntryPath, installedLockPath } from "../adapters/index.js";
import { AcpConnection, AcpConnectionError, boundMeta } from "./acpConnection.js";

const FIXTURE_PATH = fileURLToPath(new URL("./__fixtures__/fakeAcpAdapter.cjs", import.meta.url));

let homeDir: string;

/** Installs the fake adapter (`__fixtures__/fakeAcpAdapter.cjs`) so the real `resolveAdapterSpawn` resolves to it, exactly as it would a real managed install — no test-only spawn seam bypass. */
async function installFakeAdapter(mode?: string): Promise<void> {
  const entry = ADAPTER_MANIFEST["claude-code"];
  const lockPath = installedLockPath(homeDir);
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(
    lockPath,
    JSON.stringify({
      packages: {
        [`node_modules/${entry.packageName}`]: {
          version: entry.version,
          integrity: entry.integrity,
        },
      },
    }),
    "utf8",
  );
  const entryPath = adapterEntryPath("claude-code", homeDir);
  await mkdir(path.dirname(entryPath), { recursive: true });
  const fixtureSource = await readFile(FIXTURE_PATH, "utf8");
  await writeFile(entryPath, fixtureSource, "utf8");
  void mode;
}

function createConnection(
  mode?: string,
  deps?: ConstructorParameters<typeof AcpConnection>[1],
): AcpConnection {
  return new AcpConnection(
    {
      adapterId: "claude-code",
      homeDir,
      clientInfo: { name: "falcon-test", version: "0.0.0" },
      envOverrides: mode ? { FAKE_ACP_MODE: mode } : undefined,
    },
    deps,
  );
}

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "falcon-acp-connection-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe("AcpConnection.connect", () => {
  // A2: "not-installed" now triggers an auto-install attempt before giving
  // up (design §7.9) — this proves the *still-fails* half of that: if the
  // auto-install itself fails, connect() still refuses honestly rather than
  // pretending to succeed. Injects a failing `installAdapter` fake so this
  // never shells out to a real `npm install`.
  it("refuses to connect when the adapter isn't installed and auto-install fails", async () => {
    const installAdapterSpy = vi.fn(async () => ({
      id: "claude-code" as const,
      ok: false as const,
      error: "simulated npm install failure",
    }));
    const connection = createConnection(undefined, { installAdapter: installAdapterSpy });
    await expect(connection.connect()).rejects.toThrow(AcpConnectionError);
    await expect(connection.connect()).rejects.toThrow(/auto-install failed/);
    expect(connection.getState()).toBe("closed");
    expect(installAdapterSpy).toHaveBeenCalled();
  });

  // A2's actual fix: a clean "never installed" verification result now
  // auto-installs (via the real install pipeline's seam, faked here to
  // avoid a real `npm install`/network call) and then connects successfully
  // — a daemon-initiated spawn no longer has to fail once just to trigger a
  // manual `falcon adapters install` before it can ever work.
  it("auto-installs the adapter when verification reports not-installed, then connects", async () => {
    const entry = ADAPTER_MANIFEST["claude-code"];
    const installAdapterSpy = vi.fn(async () => {
      await installFakeAdapter();
      return {
        id: "claude-code" as const,
        ok: true as const,
        status: "installed" as const,
        version: entry.version,
        path: adapterEntryPath("claude-code", homeDir),
      };
    });
    const connection = createConnection(undefined, { installAdapter: installAdapterSpy });
    await connection.connect();
    try {
      expect(installAdapterSpy).toHaveBeenCalledOnce();
      expect(connection.getState()).toBe("ready");
    } finally {
      await connection.disconnect();
    }
  });

  // No redundant install: an already-correctly-installed adapter must never
  // trigger the auto-install path at all.
  it("does not attempt an auto-install when the adapter is already correctly installed", async () => {
    await installFakeAdapter();
    const installAdapterSpy = vi.fn();
    const connection = createConnection(undefined, { installAdapter: installAdapterSpy });
    await connection.connect();
    try {
      expect(installAdapterSpy).not.toHaveBeenCalled();
      expect(connection.getState()).toBe("ready");
    } finally {
      await connection.disconnect();
    }
  });

  // A2's deliberate scoping decision: an integrity mismatch (installed bytes
  // don't match the pinned manifest hash — `verify.ts`'s "tampered/
  // corrupted install" case) must still fail loudly and must NOT trigger an
  // auto-reinstall, since silently reinstalling over it would mask exactly
  // the signal this check exists to raise.
  it("still fails loudly on an integrity mismatch, without attempting an auto-reinstall", async () => {
    const entry = ADAPTER_MANIFEST["claude-code"];
    const lockPath = installedLockPath(homeDir);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        packages: {
          [`node_modules/${entry.packageName}`]: {
            version: entry.version,
            integrity: "sha512-tampered-does-not-match-manifest",
          },
        },
      }),
      "utf8",
    );
    const entryPath = adapterEntryPath("claude-code", homeDir);
    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(entryPath, await readFile(FIXTURE_PATH, "utf8"), "utf8");

    const installAdapterSpy = vi.fn();
    const connection = createConnection(undefined, { installAdapter: installAdapterSpy });
    await expect(connection.connect()).rejects.toThrow(/integrity-mismatch/);
    expect(installAdapterSpy).not.toHaveBeenCalled();
    expect(connection.getState()).toBe("closed");
  });

  // Same scoping decision for a version bump: `falcon adapters upgrade` is
  // the intended, visible path for this, not a silent background reinstall
  // triggered by a daemon spawn.
  it("still fails loudly on a version mismatch, without attempting an auto-reinstall", async () => {
    const entry = ADAPTER_MANIFEST["claude-code"];
    const lockPath = installedLockPath(homeDir);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        packages: {
          [`node_modules/${entry.packageName}`]: {
            version: "0.0.1-old",
            integrity: entry.integrity,
          },
        },
      }),
      "utf8",
    );
    const entryPath = adapterEntryPath("claude-code", homeDir);
    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(entryPath, await readFile(FIXTURE_PATH, "utf8"), "utf8");

    const installAdapterSpy = vi.fn();
    const connection = createConnection(undefined, { installAdapter: installAdapterSpy });
    await expect(connection.connect()).rejects.toThrow(/version-mismatch/);
    expect(installAdapterSpy).not.toHaveBeenCalled();
    expect(connection.getState()).toBe("closed");
  });

  it("completes the initialize handshake against a real spawned adapter child", async () => {
    await installFakeAdapter();
    const connection = createConnection();
    await connection.connect();
    try {
      expect(connection.getState()).toBe("ready");
      expect(connection.getAgentInfo()).toEqual({ name: "fake-acp-adapter", version: "0.0.1" });
      expect(connection.supportsSessionLoad()).toBe(true);
      expect(connection.supportsSessionResume()).toBe(true);
    } finally {
      await connection.disconnect();
    }
  });

  it("declares no fs and no terminal client capabilities", async () => {
    // The fake adapter doesn't echo clientCapabilities back, so this is
    // asserted structurally instead: `AcpConnection` never registers fs/
    // terminal request handlers at all (design: "client capabilities (no
    // fs, no terminal initially)") — there is no `readTextFile`/
    // `writeTextFile`/`createTerminal` method on the public API.
    await installFakeAdapter();
    const connection = createConnection();
    await connection.connect();
    try {
      const asAny = connection as unknown as Record<string, unknown>;
      expect(asAny.readTextFile).toBeUndefined();
      expect(asAny.writeTextFile).toBeUndefined();
      expect(asAny.createTerminal).toBeUndefined();
    } finally {
      await connection.disconnect();
    }
  });

  it("surfaces the ring-buffered stderr tail when the adapter crashes before responding to initialize", async () => {
    await installFakeAdapter();
    const connection = createConnection("crash-on-init");
    let caught: unknown;
    try {
      await connection.connect();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AcpConnectionError);
    const error = caught as AcpConnectionError;
    expect(error.stderrTail).toBeDefined();
    expect(error.stderrTail).toContain("simulated crash before initialize response");
    expect(error.message).toContain("Adapter stderr:");
    expect(connection.getState()).toBe("closed");
  });

  it("is a no-op when already connecting/ready", async () => {
    await installFakeAdapter();
    const connection = createConnection();
    await connection.connect();
    try {
      await connection.connect(); // should not throw or re-spawn
      expect(connection.getState()).toBe("ready");
    } finally {
      await connection.disconnect();
    }
  });
});

describe("AcpConnection session lifecycle", () => {
  it("creates a session via session/new", async () => {
    await installFakeAdapter();
    const connection = createConnection();
    await connection.connect();
    try {
      const session = await connection.createSession({ cwd: "/tmp/project" });
      expect(session.sessionId).toBe("sess-1");
    } finally {
      await connection.disconnect();
    }
  });

  it("loads and resumes a session when the agent advertises support", async () => {
    await installFakeAdapter();
    const connection = createConnection();
    await connection.connect();
    try {
      await expect(connection.loadSession("sess-1", "/tmp/project")).resolves.toEqual({
        modes: null,
      });
      await expect(connection.resumeSession("sess-1", "/tmp/project")).resolves.toEqual({
        modes: null,
      });
    } finally {
      await connection.disconnect();
    }
  });

  it("rejects session/prompt, session/new, etc. before connect()", async () => {
    const connection = createConnection();
    await expect(connection.createSession({ cwd: "/tmp" })).rejects.toThrow(/not ready/);
    await expect(connection.prompt("sess-1", [])).rejects.toThrow(/not ready/);
    await expect(connection.setMode("sess-1", "plan")).rejects.toThrow(/not ready/);
  });

  it("surfaces 'not ready' (not a misleading capability error) for loadSession/resumeSession before connect()", async () => {
    const connection = createConnection();
    await expect(connection.loadSession("sess-1", "/tmp")).rejects.toThrow(/not ready/);
    await expect(connection.resumeSession("sess-1", "/tmp")).rejects.toThrow(/not ready/);
  });
});

describe("AcpConnection.prompt", () => {
  it("resolves with the agent's PromptResponse", async () => {
    await installFakeAdapter();
    const connection = createConnection();
    await connection.connect();
    try {
      const session = await connection.createSession({ cwd: "/tmp" });
      const response = await connection.prompt(session.sessionId, [{ type: "text", text: "hi" }]);
      expect(response.stopReason).toBe("end_turn");
    } finally {
      await connection.disconnect();
    }
  });

  it("throws when a second prompt is issued while one is already in flight for the same session", async () => {
    await installFakeAdapter("slow-prompt");
    const connection = createConnection("slow-prompt");
    await connection.connect();
    try {
      const session = await connection.createSession({ cwd: "/tmp" });
      const first = connection.prompt(session.sessionId, [{ type: "text", text: "hi" }]);
      await expect(
        connection.prompt(session.sessionId, [{ type: "text", text: "again" }]),
      ).rejects.toThrow(/already in flight/);
      await connection.cancel(session.sessionId);
      await expect(first).resolves.toEqual({ stopReason: "cancelled" });
    } finally {
      await connection.disconnect();
    }
  });

  it("cancel() resolves the in-flight prompt with stopReason 'cancelled'", async () => {
    await installFakeAdapter("slow-prompt");
    const connection = createConnection("slow-prompt");
    await connection.connect();
    try {
      const session = await connection.createSession({ cwd: "/tmp" });
      const pending = connection.prompt(session.sessionId, [{ type: "text", text: "hi" }]);
      await connection.cancel(session.sessionId);
      await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
    } finally {
      await connection.disconnect();
    }
  });

  it("allows a fresh prompt once the previous one for that session has settled", async () => {
    await installFakeAdapter();
    const connection = createConnection();
    await connection.connect();
    try {
      const session = await connection.createSession({ cwd: "/tmp" });
      await connection.prompt(session.sessionId, [{ type: "text", text: "one" }]);
      await expect(
        connection.prompt(session.sessionId, [{ type: "text", text: "two" }]),
      ).resolves.toEqual({
        stopReason: "end_turn",
      });
    } finally {
      await connection.disconnect();
    }
  });
});

describe("AcpConnection.setMode", () => {
  it("sends session/set_mode and resolves", async () => {
    await installFakeAdapter();
    const connection = createConnection();
    await connection.connect();
    try {
      await expect(connection.setMode("sess-1", "plan")).resolves.toBeUndefined();
    } finally {
      await connection.disconnect();
    }
  });
});

describe("AcpConnection session-update buffering", () => {
  it("buffers updates emitted before the first onSessionUpdate() subscriber and flushes them in order", async () => {
    await installFakeAdapter();
    const connection = createConnection();
    await connection.connect();
    try {
      const session = await connection.createSession({ cwd: "/tmp" });
      // The prompt's session/update notification arrives and is buffered —
      // nobody has subscribed yet.
      await connection.prompt(session.sessionId, [{ type: "text", text: "hi" }]);

      const received: SessionNotification[] = [];
      connection.onSessionUpdate((notification) => received.push(notification));

      expect(received).toHaveLength(1);
      expect(received[0]?.update).toEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello from fake agent" },
      });
    } finally {
      await connection.disconnect();
    }
  });

  it("delivers updates live to an already-subscribed listener", async () => {
    await installFakeAdapter();
    const connection = createConnection();
    await connection.connect();
    try {
      const received: SessionNotification[] = [];
      connection.onSessionUpdate((notification) => received.push(notification));

      const session = await connection.createSession({ cwd: "/tmp" });
      await connection.prompt(session.sessionId, [{ type: "text", text: "hi" }]);

      expect(received).toHaveLength(1);
    } finally {
      await connection.disconnect();
    }
  });

  it("drops an oversized _meta payload but still delivers the rest of the update (cheap _meta bounds check)", async () => {
    await installFakeAdapter("huge-meta");
    const connection = createConnection("huge-meta");
    await connection.connect();
    try {
      const session = await connection.createSession({ cwd: "/tmp" });
      await connection.prompt(session.sessionId, [{ type: "text", text: "hi" }]);

      const received: SessionNotification[] = [];
      connection.onSessionUpdate((notification) => received.push(notification));

      expect(received).toHaveLength(1);
      expect(received[0]?._meta).toBeNull();
      expect(received[0]?.update).toEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      });
    } finally {
      await connection.disconnect();
    }
  });
});

describe("boundMeta", () => {
  // Direct unit tests for the two drop paths that can't be exercised via a
  // real spawned adapter, for two different reasons:
  //  - "unserializable": both inbound call sites (`emitSessionUpdate`,
  //    `handlePermissionRequest`) only ever feed `boundMeta` a `_meta` that
  //    already round-tripped through `JSON.parse` on the wire, which can
  //    never produce a value that then fails `JSON.stringify` (no circular
  //    refs, no `BigInt`).
  //  - "not a plain object": the `@agentclientprotocol/sdk`'s own generated
  //    zod schemas (`schema/zod.gen.js`) validate every `_meta` field as
  //    `z.record(z.string(), z.unknown()).nullish()` wrapped in a
  //    `defaultOnError(..., () => undefined)` — so a non-record `_meta`
  //    (e.g. an array) sent by a real adapter is already defaulted to
  //    `undefined` by the SDK itself before `emitSessionUpdate`/
  //    `handlePermissionRequest` ever call `boundMeta`. An end-to-end fixture
  //    test asserting this branch fires was tried and confirmed unreachable
  //    (the notification arrives with `_meta: undefined`, not the dropped
  //    `null` `boundMeta` itself would have produced).
  // Both are real defensive code for callers other than the two wire-sourced
  // ones `acpConnection.ts` has today — verified directly here instead.
  const testLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  it("passes undefined and null through unchanged", () => {
    expect(boundMeta(undefined, testLogger, "test")).toBeUndefined();
    expect(boundMeta(null, testLogger, "test")).toBeNull();
  });

  it("drops a non-plain-object (array) _meta value", () => {
    const warnings: unknown[][] = [];
    const logger = { ...testLogger, warn: (...args: unknown[]) => warnings.push(args) };
    expect(boundMeta(["not", "an", "object"], logger, "test-context")).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toContain("not a plain object");
  });

  it("drops an unserializable (circular) _meta value", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const warnings: unknown[][] = [];
    const logger = { ...testLogger, warn: (...args: unknown[]) => warnings.push(args) };
    expect(boundMeta(circular, logger, "test-context")).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toContain("unserializable");
  });

  it("passes a small plain object through unchanged", () => {
    const meta = { foo: "bar" };
    expect(boundMeta(meta, testLogger, "test")).toEqual(meta);
  });
});

describe("AcpConnection permission-request seam", () => {
  it("auto-cancels a request when no handler is set", async () => {
    await installFakeAdapter("permission-request");
    const connection = createConnection("permission-request");
    await connection.connect();
    try {
      const session = await connection.createSession({ cwd: "/tmp" });
      const response = await connection.prompt(session.sessionId, [{ type: "text", text: "hi" }]);
      // No handler set -> {outcome:{outcome:'cancelled'}} -> fake adapter
      // treats "not selected 'allow'" as a refusal.
      expect(response.stopReason).toBe("refusal");
    } finally {
      await connection.disconnect();
    }
  });

  it("routes the request through an injected handler and forwards its decision", async () => {
    await installFakeAdapter("permission-request");
    const connection = createConnection("permission-request");
    let handlerCalledWith: unknown;
    connection.setPermissionHandler(async (params) => {
      handlerCalledWith = params;
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });
    await connection.connect();
    try {
      const session = await connection.createSession({ cwd: "/tmp" });
      const response = await connection.prompt(session.sessionId, [{ type: "text", text: "hi" }]);
      expect(response.stopReason).toBe("end_turn");
      expect(handlerCalledWith).toMatchObject({ sessionId: session.sessionId });
    } finally {
      await connection.disconnect();
    }
  });
});

describe("AcpConnection post-ready failure surfacing", () => {
  it("emits onError with the stderr tail when the adapter crashes unexpectedly after ready", async () => {
    await installFakeAdapter("crash-after-ready");
    const connection = createConnection("crash-after-ready");
    await connection.connect();

    const errorPromise = new Promise<AcpConnectionError>((resolve) => {
      connection.onError((error) => resolve(error));
    });

    const error = await errorPromise;
    expect(error).toBeInstanceOf(AcpConnectionError);
    expect(error.stderrTail).toContain("simulated crash after ready");
    expect(connection.getState()).toBe("closed");
  });

  it("does not emit onError for a deliberate disconnect()", async () => {
    await installFakeAdapter();
    const connection = createConnection();
    await connection.connect();
    let errored = false;
    connection.onError(() => {
      errored = true;
    });
    await connection.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errored).toBe(false);
    expect(connection.getState()).toBe("closed");
  });
});
