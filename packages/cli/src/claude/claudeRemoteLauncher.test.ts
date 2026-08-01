import { createEnvelope, type SessionEnvelope } from "@kvy/wire";
import { describe, expect, it, vi } from "vitest";
import type { AcpRemoteHandle, AcpRemoteOptions } from "../acp/acpRemote.js";
import type { MessageBuffer } from "../remote/messageBuffer.js";
import { RemoteModeDisplay } from "../remote/RemoteModeDisplay.js";
import {
  type ClaudeRemoteLauncherDeps,
  type ClaudeRemoteLauncherOptions,
  startClaudeRemoteLauncher,
} from "./claudeRemoteLauncher.js";
import { ModeSwitchDedupe } from "./loop.js";

interface FakeRemote {
  handle: AcpRemoteHandle;
  sentPrompts: string[];
  /** Same sends, paired with whatever id (or lack of one) `send()` was called with — mirrors the real `acpRemote.ts`'s `send(prompt, id?)` shape. */
  sentMessages: Array<{ text: string; id?: string }>;
  stop: ReturnType<typeof vi.fn>;
}

/** Fake `startAcpRemote()` — `send()` emits a user text envelope directly (reusing the given id, same as the real implementation), `stop()` returns a fixed providerSessionId. */
function fakeStartAcpRemote(providerSessionId: string | null): {
  start: NonNullable<ClaudeRemoteLauncherDeps["startAcpRemote"]>;
  fake: FakeRemote;
} {
  const sentPrompts: string[] = [];
  const sentMessages: Array<{ text: string; id?: string }> = [];
  let capturedOnEnvelopes: ((envs: SessionEnvelope[]) => void) | undefined;
  const stop = vi.fn(async () => ({ providerSessionId }));

  const handle: AcpRemoteHandle = {
    send: (prompt: string, id?: string) => {
      sentPrompts.push(prompt);
      sentMessages.push({ text: prompt, id });
      capturedOnEnvelopes?.([createEnvelope("user", { t: "text", md: prompt }, { id })]);
    },
    interrupt: async () => {},
    setMode: async () => {},
    resolvePermission: () => ({ ok: false }),
    stop,
  };

  const start = ((opts: AcpRemoteOptions) => {
    capturedOnEnvelopes = opts.onEnvelopes;
    return handle;
  }) as unknown as NonNullable<ClaudeRemoteLauncherDeps["startAcpRemote"]>;

  return { start, fake: { handle, sentPrompts, sentMessages, stop } };
}

function baseOptions(
  overrides: Partial<ClaudeRemoteLauncherOptions> = {},
): ClaudeRemoteLauncherOptions {
  return {
    workingDirectory: "/tmp/work",
    permissionMode: "default",
    homeDir: "/tmp/kvy-home",
    onEnvelopes: () => {},
    dedupe: new ModeSwitchDedupe(),
    ...overrides,
  };
}

describe("startClaudeRemoteLauncher", () => {
  it("sends every initialMessage in order as soon as the query starts", async () => {
    const { start, fake } = fakeStartAcpRemote("prov-1");
    const handle = startClaudeRemoteLauncher(
      baseOptions({
        initialMessages: [
          { id: "m1", text: "first" },
          { id: "m2", text: "second" },
        ],
      }),
      { startAcpRemote: start },
    );
    handle.requestExit();
    await handle.done;
    expect(fake.sentPrompts).toEqual(["first", "second"]);
  });

  it("delivers a mid-run message directly into the live query", async () => {
    const { start, fake } = fakeStartAcpRemote("prov-1");
    const handle = startClaudeRemoteLauncher(baseOptions(), { startAcpRemote: start });
    handle.deliverMessage({ id: "m1", text: "hi there" });
    handle.requestExit();
    await handle.done;
    expect(fake.sentPrompts).toEqual(["hi there"]);
  });

  it("preserves the message RPC's id when delivering mid-run (regression: web Composer's optimistic entry never reconciled, duplicating on screen)", async () => {
    const { start, fake } = fakeStartAcpRemote("prov-1");
    const handle = startClaudeRemoteLauncher(baseOptions(), { startAcpRemote: start });
    handle.deliverMessage({ id: "web-minted-id-123", text: "hi there" });
    handle.requestExit();
    await handle.done;
    expect(fake.sentMessages).toEqual([{ text: "hi there", id: "web-minted-id-123" }]);
  });

  it("preserves each initialMessage's own id when sent at query start", async () => {
    const { start, fake } = fakeStartAcpRemote("prov-1");
    const handle = startClaudeRemoteLauncher(
      baseOptions({
        initialMessages: [
          { id: "m1", text: "first" },
          { id: "m2", text: "second" },
        ],
      }),
      { startAcpRemote: start },
    );
    handle.requestExit();
    await handle.done;
    expect(fake.sentMessages).toEqual([
      { text: "first", id: "m1" },
      { text: "second", id: "m2" },
    ]);
  });

  it("resolves 'exit' and does not emit a mode-switch envelope on requestExit()", async () => {
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();
    const { start } = fakeStartAcpRemote("prov-1");
    const handle = startClaudeRemoteLauncher(baseOptions({ onEnvelopes }), {
      startAcpRemote: start,
    });
    handle.requestExit();
    const result = await handle.done;
    expect(result).toEqual({ type: "exit" });
    expect(
      onEnvelopes.mock.calls.some(([envs]) => envs.some((e) => e.ev.t === "mode-switch")),
    ).toBe(false);
  });

  it("resolves 'switch', captures providerSessionId, and emits a mode-switch envelope on requestSwitchToLocal()", async () => {
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();
    const { start, fake } = fakeStartAcpRemote("prov-42");
    const handle = startClaudeRemoteLauncher(baseOptions({ onEnvelopes }), {
      startAcpRemote: start,
    });
    handle.requestSwitchToLocal();
    const result = await handle.done;
    expect(result).toEqual({ type: "switch", providerSessionId: "prov-42" });
    expect(fake.stop).toHaveBeenCalledOnce();

    const delivered = onEnvelopes.mock.calls.flatMap(([envs]) => envs);
    expect(delivered).toEqual([
      expect.objectContaining({ ev: { t: "mode-switch", control: "local", by: "client" } }),
    ]);
  });

  it("only settles on the first of requestSwitchToLocal()/requestExit() — later calls are no-ops", async () => {
    const { start, fake } = fakeStartAcpRemote("prov-1");
    const handle = startClaudeRemoteLauncher(baseOptions(), { startAcpRemote: start });
    handle.requestSwitchToLocal();
    handle.requestExit();
    handle.requestSwitchToLocal();
    const result = await handle.done;
    expect(result.type).toBe("switch");
    expect(fake.stop).toHaveBeenCalledOnce();
  });

  it("drops a message delivered after the run has already settled", async () => {
    const { start, fake } = fakeStartAcpRemote("prov-1");
    const handle = startClaudeRemoteLauncher(baseOptions(), { startAcpRemote: start });
    handle.requestExit();
    await handle.done;
    handle.deliverMessage({ id: "late", text: "too late" });
    expect(fake.sentPrompts).toEqual([]);
  });

  it("filters envelopes already forwarded via the shared dedupe", async () => {
    const dedupe = new ModeSwitchDedupe();
    dedupe.isDuplicate(createEnvelope("user", { t: "text", md: "dup me" }));

    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();
    const { start } = fakeStartAcpRemote("prov-1");
    const handle = startClaudeRemoteLauncher(baseOptions({ onEnvelopes, dedupe }), {
      startAcpRemote: start,
    });
    handle.deliverMessage({ id: "m1", text: "dup me" });
    handle.requestExit();
    await handle.done;

    const delivered = onEnvelopes.mock.calls.flatMap(([envs]) => envs);
    expect(delivered.some((e) => e.ev.t === "text" && e.ev.md === "dup me")).toBe(false);
  });
});

/** Minimal fake terminal — mirrors `terminalStdinCleanup.test.ts`'s fake stdin, plus a `stdout.isTTY` flag. */
function fakeTerminal(isTTY: boolean) {
  const listeners = new Map<string, Set<(chunk: unknown) => void>>();
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const stdin = {
    isTTY,
    on: (event: "data", fn: (chunk: unknown) => void) => {
      calls.push({ name: "on", args: [event] });
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
      return stdin;
    },
    off: (event: "data", fn: (chunk: unknown) => void) => {
      calls.push({ name: "off", args: [event] });
      listeners.get(event)?.delete(fn);
      return stdin;
    },
    resume: () => calls.push({ name: "resume", args: [] }),
    pause: () => calls.push({ name: "pause", args: [] }),
    setEncoding: (encoding: string) => calls.push({ name: "setEncoding", args: [encoding] }),
    setRawMode: (value: boolean) => calls.push({ name: "setRawMode", args: [value] }),
  };
  return { stdout: { isTTY }, stdin, __calls: calls };
}

describe("startClaudeRemoteLauncher — terminal UI (Ink), ported wiring", () => {
  it("never renders or touches stdin when hasTTY is false (the default in any non-interactive/test context)", async () => {
    const { start } = fakeStartAcpRemote("prov-1");
    const render = vi.fn();
    const terminal = fakeTerminal(false);
    const handle = startClaudeRemoteLauncher(baseOptions(), {
      startAcpRemote: start,
      render,
      terminal,
    });
    handle.requestExit();
    await handle.done;

    expect(render).not.toHaveBeenCalled();
    expect(terminal.__calls).toEqual([]);
  });

  it("renders RemoteModeDisplay, sets raw mode, and unmounts + drains stdin on settle when hasTTY is true", async () => {
    const { start } = fakeStartAcpRemote("prov-1");
    const unmount = vi.fn();
    const render = vi.fn().mockReturnValue({ unmount });
    const terminal = fakeTerminal(true);
    vi.useFakeTimers();

    const handle = startClaudeRemoteLauncher(baseOptions(), {
      startAcpRemote: start,
      render,
      terminal,
    });

    expect(render).toHaveBeenCalledOnce();
    const [element, renderOptions] = render.mock.calls[0]!;
    expect((element as { type: unknown }).type).toBe(RemoteModeDisplay);
    expect(renderOptions).toEqual({ exitOnCtrlC: false, patchConsole: false });
    expect(terminal.__calls.some((c) => c.name === "setRawMode" && c.args[0] === true)).toBe(true);

    handle.requestExit();
    const donePromise = handle.done;
    await vi.advanceTimersByTimeAsync(200); // let cleanupStdinAfterInk's 150ms drain elapse
    await donePromise;

    expect(unmount).toHaveBeenCalledOnce();
    // cleanupStdinAfterInk's own pause() call, after unmount.
    expect(terminal.__calls.some((c) => c.name === "pause")).toBe(true);
    vi.useRealTimers();
  });

  it("wires RemoteModeDisplay's onExit/onSwitchToLocal props to requestExit/requestSwitchToLocal", async () => {
    const { start, fake } = fakeStartAcpRemote("prov-7");
    const render = vi.fn().mockReturnValue({ unmount: vi.fn() });
    const terminal = fakeTerminal(true);
    vi.useFakeTimers();

    const handle = startClaudeRemoteLauncher(baseOptions(), {
      startAcpRemote: start,
      render,
      terminal,
    });

    const [element] = render.mock.calls[0]!;
    const props = (element as { props: { onSwitchToLocal: () => void } }).props;
    props.onSwitchToLocal(); // simulate the Ctrl-T/double-space gesture inside RemoteModeDisplay

    const donePromise = handle.done;
    await vi.advanceTimersByTimeAsync(200);
    const result = await donePromise;

    expect(result).toEqual({ type: "switch", providerSessionId: "prov-7" });
    expect(fake.stop).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("feeds forwarded (non-duplicate) envelopes into the message buffer shown by RemoteModeDisplay", async () => {
    const { start } = fakeStartAcpRemote("prov-1");
    const render = vi.fn().mockReturnValue({ unmount: vi.fn() });
    const terminal = fakeTerminal(true);
    vi.useFakeTimers();

    const handle = startClaudeRemoteLauncher(baseOptions(), {
      startAcpRemote: start,
      render,
      terminal,
    });

    const [element] = render.mock.calls[0]!;
    const buffer = (element as { props: { messageBuffer: MessageBuffer } }).props.messageBuffer;
    // `run()` clears the buffer as part of terminal cleanup on settle, so
    // capture what was shown via the same subscription RemoteModeDisplay
    // itself uses, rather than reading `buffer` after the launcher settles.
    let latestSnapshot: string[] = [];
    buffer.onUpdate((messages) => {
      latestSnapshot = messages.map((m) => m.content);
    });

    handle.deliverMessage({ id: "m1", text: "hello from the web" }); // fakeStartAcpRemote's send() emits a matching user envelope
    expect(latestSnapshot.some((c) => c.includes("hello from the web"))).toBe(true);

    handle.requestExit();
    const donePromise = handle.done;
    await vi.advanceTimersByTimeAsync(200);
    await donePromise;

    expect(buffer.getMessages()).toEqual([]); // cleared as part of terminal cleanup
    vi.useRealTimers();
  });
});
