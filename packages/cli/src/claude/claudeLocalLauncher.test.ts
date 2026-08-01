import type { SessionEnvelope } from "@kvy/wire";
import { describe, expect, it, vi } from "vitest";
import { ExitCodeError } from "./claudeLocal.js";
import {
  type ClaudeLocalLauncherDeps,
  type ClaudeLocalLauncherOptions,
  startClaudeLocalLauncher,
} from "./claudeLocalLauncher.js";
import { ModeSwitchDedupe, type QueuedMessage } from "./loop.js";
import type { SessionScanner } from "./scanner.js";

function baseOptions(
  overrides: Partial<ClaudeLocalLauncherOptions> = {},
): ClaudeLocalLauncherOptions {
  return {
    workingDirectory: "/tmp/work",
    providerSessionId: null,
    onProviderSessionId: () => {},
    onEnvelopes: () => {},
    dedupe: new ModeSwitchDedupe(),
    ...overrides,
  };
}

/** Fake `claudeLocal()` that resolves immediately — a local session that ends on its own, no switch involved. */
function fakeClaudeLocal(
  mintId: () => string,
): NonNullable<ClaudeLocalLauncherDeps["claudeLocal"]> {
  return async (opts) => {
    const id = opts.sessionId ?? mintId();
    if (!opts.sessionId) opts.onSessionFound(id);
    return id;
  };
}

function fakeScanner(onMessage?: (raw: unknown) => void): SessionScanner {
  return {
    cleanup: async () => {},
    flush: async () => {},
    onNewSession: async (id) => {
      onMessage?.(id);
    },
  };
}

function baseDeps(overrides: Partial<ClaudeLocalLauncherDeps> = {}): ClaudeLocalLauncherDeps {
  return {
    launcherPath: "/fake/launcher.cjs",
    claudeLocal: fakeClaudeLocal(() => "fresh-session"),
    createSessionScanner: async () => fakeScanner(),
    ...overrides,
  };
}

describe("startClaudeLocalLauncher", () => {
  it("resolves 'exit' with code 0 when the child exits cleanly and no switch was requested", async () => {
    const handle = startClaudeLocalLauncher(baseOptions(), baseDeps());
    const result = await handle.done;
    expect(result).toEqual({ type: "exit", code: 0 });
  });

  it("resolves 'exit' with the child's exit code on a non-zero exit", async () => {
    const deps = baseDeps({
      claudeLocal: async () => {
        throw new ExitCodeError(3);
      },
    });
    const handle = startClaudeLocalLauncher(baseOptions(), deps);
    const result = await handle.done;
    expect(result).toEqual({ type: "exit", code: 3 });
  });

  it("resolves 'switch' with queued messages when requestSwitch() aborts the child", async () => {
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();
    const handle = startClaudeLocalLauncher(
      baseOptions({ providerSessionId: "resumed-session", onEnvelopes }),
      baseDeps(),
    );

    const message: QueuedMessage = { id: "m1", text: "hello from web" };
    handle.requestSwitch(message);

    const result = await handle.done;
    expect(result).toEqual({
      type: "switch",
      providerSessionId: "resumed-session",
      queuedMessages: [message],
    });

    const delivered = onEnvelopes.mock.calls.flatMap(([envs]) => envs);
    expect(delivered).toEqual([
      expect.objectContaining({ ev: { t: "mode-switch", control: "remote", by: "client" } }),
    ]);
  });

  it("collects every message queued before the child actually exits, in order", async () => {
    const handle = startClaudeLocalLauncher(baseOptions(), baseDeps());

    handle.requestSwitch({ id: "m1", text: "first" });
    handle.requestSwitch({ id: "m2", text: "second" });
    handle.requestSwitch(); // takeControl-style trigger with no message

    const result = await handle.done;
    expect(result).toEqual({
      type: "switch",
      providerSessionId: "fresh-session",
      queuedMessages: [
        { id: "m1", text: "first" },
        { id: "m2", text: "second" },
      ],
    });
  });

  it("only aborts the child once even if requestSwitch is called repeatedly", async () => {
    let abortCount = 0;
    const deps = baseDeps({
      claudeLocal: async (opts) => {
        // The signal may already be aborted by the time this fake runs
        // (requestSwitch() below fires before `run()`'s pending
        // `createSessionScanner()` await even resolves) — a listener added
        // after the fact would never see that dispatch, so count via the
        // synchronous state instead of relying on the event firing here.
        if (opts.abort.aborted) {
          abortCount++;
          return "s1";
        }
        opts.abort.addEventListener(
          "abort",
          () => {
            abortCount++;
          },
          { once: true },
        );
        await new Promise<void>((resolve) => {
          opts.abort.addEventListener("abort", () => resolve(), { once: true });
        });
        return "s1";
      },
    });
    const handle = startClaudeLocalLauncher(baseOptions(), deps);
    handle.requestSwitch({ id: "a", text: "a" });
    handle.requestSwitch({ id: "b", text: "b" });
    await handle.done;
    expect(abortCount).toBe(1);
  });

  it("treats a non-zero exit racing an in-flight switch request as a switch, not a crash, and still emits the mode-switch envelope", async () => {
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();
    const deps = baseDeps({
      claudeLocal: async (opts) => {
        if (!opts.abort.aborted) {
          await new Promise<void>((resolve) => {
            opts.abort.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        throw new ExitCodeError(1);
      },
    });
    const handle = startClaudeLocalLauncher(
      baseOptions({ providerSessionId: "s1", onEnvelopes }),
      deps,
    );
    handle.requestSwitch({ id: "m1", text: "hi" });
    const result = await handle.done;
    expect(result).toEqual({
      type: "switch",
      providerSessionId: "s1",
      queuedMessages: [{ id: "m1", text: "hi" }],
    });

    const delivered = onEnvelopes.mock.calls.flatMap(([envs]) => envs);
    expect(delivered).toEqual([
      expect.objectContaining({ ev: { t: "mode-switch", control: "remote", by: "client" } }),
    ]);
  });

  it("reports the effective session id via onProviderSessionId and seeds the scanner's onNewSession", async () => {
    const onProviderSessionId = vi.fn<(id: string) => void>();
    const onNewSessionCalls: string[] = [];
    const deps = baseDeps({
      createSessionScanner: async () => fakeScanner((id) => onNewSessionCalls.push(id as string)),
      claudeLocal: fakeClaudeLocal(() => "brand-new-id"),
    });
    const handle = startClaudeLocalLauncher(baseOptions({ onProviderSessionId }), deps);
    await handle.done;
    expect(onProviderSessionId).toHaveBeenCalledExactlyOnceWith("brand-new-id");
    expect(onNewSessionCalls).toEqual(["brand-new-id"]);
  });

  it("filters transcript envelopes already forwarded via the shared dedupe", async () => {
    const dedupe = new ModeSwitchDedupe();
    // Simulate the remote path having already forwarded this exact prompt.
    dedupe.isDuplicate({ id: "e0", time: 0, role: "user", ev: { t: "text", md: "dup me" } });

    let capturedOnMessage: ((raw: unknown) => void) | undefined;
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();
    const deps = baseDeps({
      createSessionScanner: async (options) => {
        capturedOnMessage = options.onMessage as unknown as (raw: unknown) => void;
        return fakeScanner();
      },
    });

    const handle = startClaudeLocalLauncher(baseOptions({ dedupe, onEnvelopes }), deps);
    await handle.done;

    capturedOnMessage?.({
      type: "user",
      uuid: "u-1",
      message: { role: "user", content: "dup me" },
    });

    const delivered = onEnvelopes.mock.calls.flatMap(([envs]) => envs);
    expect(delivered.some((e) => e.ev.t === "text" && e.ev.md === "dup me")).toBe(false);
  });
});
