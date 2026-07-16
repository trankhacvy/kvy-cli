import { createEnvelope, type SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeRemoteHandle, ClaudeRemoteOptions } from "../remote/claudeRemote.js";
import {
  type ClaudeRemoteLauncherDeps,
  type ClaudeRemoteLauncherOptions,
  startClaudeRemoteLauncher,
} from "./claudeRemoteLauncher.js";
import { ModeSwitchDedupe } from "./loop.js";

interface FakeRemote {
  handle: ClaudeRemoteHandle;
  sentPrompts: string[];
  stop: ReturnType<typeof vi.fn>;
}

/** Fake `startClaudeRemote()` — `send()` emits a user text envelope directly, `stop()` returns a fixed/incrementing providerSessionId. */
function fakeStartClaudeRemote(providerSessionId: string | null): {
  start: NonNullable<ClaudeRemoteLauncherDeps["startClaudeRemote"]>;
  fake: FakeRemote;
} {
  const sentPrompts: string[] = [];
  let capturedOnEnvelopes: ((envs: SessionEnvelope[]) => void) | undefined;
  const stop = vi.fn(async () => ({ providerSessionId }));

  const handle: ClaudeRemoteHandle = {
    send: (prompt: string) => {
      sentPrompts.push(prompt);
      capturedOnEnvelopes?.([createEnvelope("user", { t: "text", md: prompt })]);
    },
    interrupt: async () => {},
    setMode: async () => {},
    stop,
  };

  const start = ((opts: ClaudeRemoteOptions) => {
    capturedOnEnvelopes = opts.onEnvelopes;
    return handle;
  }) as unknown as NonNullable<ClaudeRemoteLauncherDeps["startClaudeRemote"]>;

  return { start, fake: { handle, sentPrompts, stop } };
}

function baseOptions(
  overrides: Partial<ClaudeRemoteLauncherOptions> = {},
): ClaudeRemoteLauncherOptions {
  return {
    workingDirectory: "/tmp/work",
    permissionMode: "default",
    onEnvelopes: () => {},
    dedupe: new ModeSwitchDedupe(),
    ...overrides,
  };
}

describe("startClaudeRemoteLauncher", () => {
  it("sends every initialMessage in order as soon as the query starts", async () => {
    const { start, fake } = fakeStartClaudeRemote("prov-1");
    const handle = startClaudeRemoteLauncher(
      baseOptions({
        initialMessages: [
          { id: "m1", text: "first" },
          { id: "m2", text: "second" },
        ],
      }),
      { startClaudeRemote: start },
    );
    handle.requestExit();
    await handle.done;
    expect(fake.sentPrompts).toEqual(["first", "second"]);
  });

  it("delivers a mid-run message directly into the live query", async () => {
    const { start, fake } = fakeStartClaudeRemote("prov-1");
    const handle = startClaudeRemoteLauncher(baseOptions(), { startClaudeRemote: start });
    handle.deliverMessage({ id: "m1", text: "hi there" });
    handle.requestExit();
    await handle.done;
    expect(fake.sentPrompts).toEqual(["hi there"]);
  });

  it("resolves 'exit' and does not emit a mode-switch envelope on requestExit()", async () => {
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();
    const { start } = fakeStartClaudeRemote("prov-1");
    const handle = startClaudeRemoteLauncher(baseOptions({ onEnvelopes }), {
      startClaudeRemote: start,
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
    const { start, fake } = fakeStartClaudeRemote("prov-42");
    const handle = startClaudeRemoteLauncher(baseOptions({ onEnvelopes }), {
      startClaudeRemote: start,
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
    const { start, fake } = fakeStartClaudeRemote("prov-1");
    const handle = startClaudeRemoteLauncher(baseOptions(), { startClaudeRemote: start });
    handle.requestSwitchToLocal();
    handle.requestExit();
    handle.requestSwitchToLocal();
    const result = await handle.done;
    expect(result.type).toBe("switch");
    expect(fake.stop).toHaveBeenCalledOnce();
  });

  it("drops a message delivered after the run has already settled", async () => {
    const { start, fake } = fakeStartClaudeRemote("prov-1");
    const handle = startClaudeRemoteLauncher(baseOptions(), { startClaudeRemote: start });
    handle.requestExit();
    await handle.done;
    handle.deliverMessage({ id: "late", text: "too late" });
    expect(fake.sentPrompts).toEqual([]);
  });

  it("filters envelopes already forwarded via the shared dedupe", async () => {
    const dedupe = new ModeSwitchDedupe();
    dedupe.isDuplicate(createEnvelope("user", { t: "text", md: "dup me" }));

    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();
    const { start } = fakeStartClaudeRemote("prov-1");
    const handle = startClaudeRemoteLauncher(baseOptions({ onEnvelopes, dedupe }), {
      startClaudeRemote: start,
    });
    handle.deliverMessage({ id: "m1", text: "dup me" });
    handle.requestExit();
    await handle.done;

    const delivered = onEnvelopes.mock.calls.flatMap(([envs]) => envs);
    expect(delivered.some((e) => e.ev.t === "text" && e.ev.md === "dup me")).toBe(false);
  });
});
