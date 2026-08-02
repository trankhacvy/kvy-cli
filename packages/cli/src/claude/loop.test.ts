import { createEnvelope, type SessionEnvelope } from "@kvy/wire";
import { describe, expect, it } from "vitest";
import type { ClaudeLocalLauncherDeps } from "./claudeLocalLauncher.js";
import type { ClaudeRemoteLauncherDeps } from "./claudeRemoteLauncher.js";
import {
  type LoopDeps,
  type LoopOptions,
  loop,
  ModeSwitchDedupe,
  type QueuedMessage,
} from "./loop.js";

function textEnvelope(role: "user" | "agent", md: string): SessionEnvelope {
  return createEnvelope(role, { t: "text", md });
}

describe("ModeSwitchDedupe", () => {
  it("reports the first occurrence of a (role, text) pair as not a duplicate, and later ones within the window as duplicates", () => {
    const dedupe = new ModeSwitchDedupe();
    expect(dedupe.isDuplicate(textEnvelope("user", "hello"))).toBe(false);
    expect(dedupe.isDuplicate(textEnvelope("user", "hello"))).toBe(true);
  });

  it("does not confuse the same text from different roles", () => {
    const dedupe = new ModeSwitchDedupe();
    expect(dedupe.isDuplicate(textEnvelope("user", "same text"))).toBe(false);
    expect(dedupe.isDuplicate(textEnvelope("agent", "same text"))).toBe(false);
  });

  it("expires entries outside the configured window", () => {
    let now = 0;
    const dedupe = new ModeSwitchDedupe({ windowMs: 1000, now: () => now });
    expect(dedupe.isDuplicate(textEnvelope("user", "hi"))).toBe(false);
    now = 1500; // past the 1000ms window
    expect(dedupe.isDuplicate(textEnvelope("user", "hi"))).toBe(false);
  });

  it("never treats non-text events as duplicates", () => {
    const dedupe = new ModeSwitchDedupe();
    const turnStart = createEnvelope("agent", { t: "turn-start" });
    expect(dedupe.isDuplicate(turnStart)).toBe(false);
    expect(dedupe.isDuplicate(turnStart)).toBe(false);
  });
});

/** A minimal external-trigger registrar the test can fire directly, matching `LoopOptions`'s `(handler) => unsubscribe` shape. */
function makeTrigger<T = void>(): {
  register: (handler: (arg: T) => void) => () => void;
  fire: (arg: T) => void;
} {
  let handler: ((arg: T) => void) | null = null;
  return {
    register: (h) => {
      handler = h;
      return () => {
        if (handler === h) handler = null;
      };
    },
    fire: (arg) => handler?.(arg),
  };
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/** Local-mode fake that stays "running" (mirrors the real spawn) until its abort signal fires. */
function makeFakeLocalDeps(counter: { n: number }): {
  deps: ClaudeLocalLauncherDeps;
  scanners: Array<{ onMessage: (raw: unknown) => void }>;
} {
  const scanners: Array<{ onMessage: (raw: unknown) => void }> = [];
  const deps: ClaudeLocalLauncherDeps = {
    launcherPath: "/fake/launcher.cjs",
    claudeLocal: async (opts) => {
      const id = opts.sessionId ?? `local-${counter.n++}`;
      if (!opts.sessionId) opts.onSessionFound(id);
      if (!opts.abort.aborted) {
        await new Promise<void>((resolve) => {
          opts.abort.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return id;
    },
    createSessionScanner: async (options) => {
      scanners.push({ onMessage: options.onMessage as unknown as (raw: unknown) => void });
      return { cleanup: async () => {}, flush: async () => {}, onNewSession: async () => {} };
    },
  };
  return { deps, scanners };
}

/** Remote-mode fake — `send()` emits a user text envelope directly (mirrors `acpRemote.ts`'s real `send()`); `stop()` returns an incrementing providerSessionId. */
function makeFakeRemoteDeps(counter: { n: number }): ClaudeRemoteLauncherDeps {
  return {
    startAcpRemote: (opts) => {
      const providerSessionId = opts.resume ?? `remote-${counter.n++}`;
      return {
        send: (text: string) => opts.onEnvelopes([createEnvelope("user", { t: "text", md: text })]),
        interrupt: async () => {},
        setMode: async () => {},
        resolvePermission: () => ({ ok: false }),
        stop: async () => ({ providerSessionId }),
      };
    },
  };
}

function baseLoopOptions(overrides: Partial<LoopOptions> = {}): {
  options: LoopOptions;
  envelopes: SessionEnvelope[];
  modeChanges: string[];
  messageTrigger: ReturnType<typeof makeTrigger<QueuedMessage>>;
  takeControlTrigger: ReturnType<typeof makeTrigger<void>>;
  exitTrigger: ReturnType<typeof makeTrigger<void>>;
} {
  const envelopes: SessionEnvelope[] = [];
  const modeChanges: string[] = [];
  const messageTrigger = makeTrigger<QueuedMessage>();
  const takeControlTrigger = makeTrigger<void>();
  const exitTrigger = makeTrigger<void>();

  const options: LoopOptions = {
    workingDirectory: "/tmp/work",
    permissionMode: "default",
    homeDir: "/tmp/kvy-home",
    onEnvelopes: (envs) => envelopes.push(...envs),
    onModeChange: (mode) => modeChanges.push(mode),
    onMessage: messageTrigger.register,
    onTakeControl: takeControlTrigger.register,
    onExitRequested: exitTrigger.register,
    ...overrides,
  };

  return { options, envelopes, modeChanges, messageTrigger, takeControlTrigger, exitTrigger };
}

describe("loop", () => {
  it("returns the local exit code when local mode exits cleanly, no switch ever requested", async () => {
    const { options } = baseLoopOptions();
    const deps: LoopDeps = {
      local: {
        launcherPath: "/fake/launcher.cjs",
        claudeLocal: async () => "s1",
        createSessionScanner: async () => ({
          cleanup: async () => {},
          flush: async () => {},
          onNewSession: async () => {},
        }),
      },
    };
    const code = await loop(options, deps);
    expect(code).toBe(0);
  });

  it("switches local -> remote -> local -> exit, carrying providerSessionId across every hop", async () => {
    const localCounter = { n: 0 };
    const remoteCounter = { n: 0 };
    const { deps: localDeps } = makeFakeLocalDeps(localCounter);
    const remoteDeps = makeFakeRemoteDeps(remoteCounter);
    const { options, modeChanges, messageTrigger, takeControlTrigger, exitTrigger } =
      baseLoopOptions();

    const loopPromise = loop(options, { local: localDeps, remote: remoteDeps });
    await flushAll();

    messageTrigger.fire({ id: "m1", text: "hi" }); // local -> remote
    await flushAll();
    expect(modeChanges).toEqual(["remote"]);

    takeControlTrigger.fire(undefined); // remote -> local
    await flushAll();
    expect(modeChanges).toEqual(["remote", "local"]);

    messageTrigger.fire({ id: "m2", text: "bye" }); // local -> remote again
    await flushAll();

    exitTrigger.fire(undefined); // ends the whole loop from remote mode
    await flushAll();

    const code = await loopPromise;
    expect(code).toBe(0);
    expect(modeChanges).toEqual(["remote", "local", "remote"]);
  });

  it("loss-lessness: a storm of rapid switches with messages queued mid-flight forwards every message exactly once", async () => {
    const localCounter = { n: 0 };
    const remoteCounter = { n: 0 };
    const { deps: localDeps, scanners } = makeFakeLocalDeps(localCounter);
    const remoteDeps = makeFakeRemoteDeps(remoteCounter);
    const { options, envelopes, messageTrigger, takeControlTrigger, exitTrigger } =
      baseLoopOptions();

    const loopPromise = loop(options, { local: localDeps, remote: remoteDeps });
    await flushAll(); // local mode #0 starts

    const messages: QueuedMessage[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      text: `message ${i}`,
    }));

    for (const [i, message] of messages.entries()) {
      // Arrives while local is in control — the loop must queue it and
      // remote message ... aborts the local child process").
      messageTrigger.fire(message);
      await flushAll();

      // On iteration 2, also exercise the "message arrives while remote is
      // already in control" path — delivered directly, no switch involved.
      if (i === 2) {
        messageTrigger.fire({ id: "m2-extra", text: "extra while remote" });
        await flushAll();
      }

      // Hand control back to the terminal — the SDK has (per the fake) just
      // "written" this turn's prompt directly via send(). Simulate the race
      // this task is actually about: the freshly-restarted local tailer
      // observes the SAME text still sitting in Claude Code's on-disk
      // transcript, from a parallel `claude --resume` write, and must not
      // re-forward it.
      takeControlTrigger.fire(undefined);
      await flushAll();

      const latestScanner = scanners.at(-1);
      latestScanner?.onMessage({
        type: "user",
        uuid: `raced-${i}`,
        message: { role: "user", content: message.text },
      });
    }

    // The storm ends back in local mode (the last takeControl switch) —
    // `onExitRequested` only reaches remote mode (double-Ctrl-C has no local
    // equivalent; local mode's own exit is the child exiting on its own), so
    // force one final switch before ending the whole client.
    messageTrigger.fire({ id: "final", text: "final message" });
    await flushAll();
    exitTrigger.fire(undefined);
    await flushAll();
    await loopPromise;

    // No drops: every queued message's text made it through exactly once
    // (no dupes) — including the one delivered mid-remote-run.
    const allTexts = [...messages.map((m) => m.text), "extra while remote", "final message"];
    for (const text of allTexts) {
      const count = envelopes.filter((e) => e.ev.t === "text" && e.ev.md === text).length;
      expect(count).toBe(1);
    }
  });
});
