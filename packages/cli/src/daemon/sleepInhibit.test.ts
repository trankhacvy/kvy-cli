import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  createSleepInhibitManager,
  type SleepInhibitChild,
  wrapChildProcess,
} from "./sleepInhibit.js";

/** A fake child the test fully controls: `exit()` simulates the process dying, `kill` is spy-able. */
function makeFakeChild() {
  let exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const kill = vi.fn(() => true);
  const child: SleepInhibitChild = {
    pid: 4242,
    kill,
    onExit: (cb) => {
      exitCb = cb;
    },
  };
  return {
    child,
    kill,
    exit: (code: number | null = null, signal: NodeJS.Signals | null = "SIGTERM") =>
      exitCb?.(code, signal),
  };
}

describe("createSleepInhibitManager", () => {
  it("spawns no child and reports off for mode 'off'", () => {
    const spawnChild = vi.fn();
    const manager = createSleepInhibitManager({
      platform: "darwin",
      daemonPid: 999,
      spawnChild,
    });

    const state = manager.applyMode("off");
    expect(state).toEqual({ supported: true, platform: "darwin", mode: "off", active: false });
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("onPower spawns exactly ['caffeinate','-s','-w','<daemonPid>']", () => {
    const fake = makeFakeChild();
    const spawnChild = vi.fn().mockReturnValue(fake.child);
    const manager = createSleepInhibitManager({ platform: "darwin", daemonPid: 4242, spawnChild });

    const state = manager.applyMode("onPower");

    expect(spawnChild).toHaveBeenCalledExactlyOnceWith(["caffeinate", "-s", "-w", "4242"]);
    expect(state).toEqual({ supported: true, platform: "darwin", mode: "onPower", active: true });
  });

  it("always spawns exactly ['caffeinate','-i','-w','<daemonPid>']", () => {
    const fake = makeFakeChild();
    const spawnChild = vi.fn().mockReturnValue(fake.child);
    const manager = createSleepInhibitManager({ platform: "darwin", daemonPid: 777, spawnChild });

    const state = manager.applyMode("always");

    expect(spawnChild).toHaveBeenCalledExactlyOnceWith(["caffeinate", "-i", "-w", "777"]);
    expect(state).toEqual({ supported: true, platform: "darwin", mode: "always", active: true });
  });

  it("kills the current child before spawning the new one on a mode change", () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    const spawnChild = vi.fn().mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);
    const manager = createSleepInhibitManager({ platform: "darwin", daemonPid: 1, spawnChild });

    manager.applyMode("onPower");
    expect(first.kill).not.toHaveBeenCalled();

    manager.applyMode("always");
    expect(first.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(spawnChild).toHaveBeenNthCalledWith(2, ["caffeinate", "-i", "-w", "1"]);
  });

  it("switching to 'off' kills the current child without spawning a replacement", () => {
    const fake = makeFakeChild();
    const spawnChild = vi.fn().mockReturnValue(fake.child);
    const manager = createSleepInhibitManager({ platform: "darwin", daemonPid: 1, spawnChild });

    manager.applyMode("always");
    const state = manager.applyMode("off");

    expect(fake.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(spawnChild).toHaveBeenCalledTimes(1);
    expect(state).toEqual({ supported: true, platform: "darwin", mode: "off", active: false });
  });

  it("is a no-op when re-applying the same mode with a healthy child", () => {
    const fake = makeFakeChild();
    const spawnChild = vi.fn().mockReturnValue(fake.child);
    const manager = createSleepInhibitManager({ platform: "darwin", daemonPid: 1, spawnChild });

    manager.applyMode("always");
    manager.applyMode("always");

    expect(spawnChild).toHaveBeenCalledTimes(1);
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it("never spawns on a non-darwin platform and always reports supported:false", () => {
    const spawnChild = vi.fn();
    const manager = createSleepInhibitManager({ platform: "linux", daemonPid: 1, spawnChild });

    const state = manager.applyMode("always");

    expect(spawnChild).not.toHaveBeenCalled();
    expect(state).toEqual({ supported: false, platform: "linux", mode: "off", active: false });
  });

  it("attempts exactly one automatic respawn after an unexpected child exit, then gives up", () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    const third = makeFakeChild();
    const spawnChild = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child)
      .mockReturnValueOnce(third.child);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const manager = createSleepInhibitManager({
      platform: "darwin",
      daemonPid: 1,
      spawnChild,
      logger,
    });

    manager.applyMode("always");
    expect(manager.getState().active).toBe(true);

    // First unexpected exit -> exactly one automatic respawn.
    first.exit();
    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(manager.getState().active).toBe(true);

    // Second unexpected exit -> give up, no third spawn, active goes false.
    second.exit();
    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(manager.getState().active).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("a fresh applyMode call after a give-up respawns again (resets the single-respawn budget)", () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    const third = makeFakeChild();
    const spawnChild = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child)
      .mockReturnValueOnce(third.child);
    const manager = createSleepInhibitManager({ platform: "darwin", daemonPid: 1, spawnChild });

    manager.applyMode("always");
    first.exit(); // respawn #1 (second.child)
    second.exit(); // give up

    expect(manager.getState().active).toBe(false);

    manager.applyMode("always"); // explicit re-apply after give-up
    expect(spawnChild).toHaveBeenCalledTimes(3);
    expect(manager.getState().active).toBe(true);
  });

  it("stop() kills the current child, is idempotent, and every applyMode call after it is a safe no-op", () => {
    const fake = makeFakeChild();
    const spawnChild = vi.fn().mockReturnValue(fake.child);
    const manager = createSleepInhibitManager({ platform: "darwin", daemonPid: 1, spawnChild });

    manager.applyMode("always");
    manager.stop();
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(manager.getState().active).toBe(false);

    expect(() => manager.stop()).not.toThrow(); // idempotent

    const state = manager.applyMode("always");
    expect(spawnChild).toHaveBeenCalledTimes(1); // no second spawn after stop()
    expect(state.active).toBe(false);
  });

  it("a spawn that throws degrades to active:false without throwing out of applyMode", () => {
    const spawnChild = vi.fn(() => {
      throw new Error("ENOENT: caffeinate not found");
    });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const manager = createSleepInhibitManager({
      platform: "darwin",
      daemonPid: 1,
      spawnChild,
      logger,
    });

    const state = manager.applyMode("always");

    expect(state).toEqual({ supported: true, platform: "darwin", mode: "always", active: false });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("wrapChildProcess's onExit fires (once) on a real ENOENT spawn failure, which never emits Node's 'exit' event — regression for a bug where a missing caffeinate binary left active:true forever", async () => {
    // A real `child_process.spawn` of a nonexistent binary: Node fires
    // "error" (ENOENT) but NEVER "exit" for a process that never actually
    // started — verified directly against the real Node runtime. A
    // `wrapChildProcess` that only listened to "exit" would silently never
    // invoke its `onExit` callback in this case, permanently reporting
    // `active: true` for a caffeinate that never ran.
    const realChild = spawn("falcon-sleep-inhibit-definitely-not-a-real-binary", [], {
      stdio: "ignore",
    });
    const wrapped = wrapChildProcess(realChild);

    const fired = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("onExit never fired")), 2000);
        wrapped.onExit((code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      },
    );

    expect(fired).toEqual({ code: null, signal: null });
  });

  it("a manager using the real (non-injected) spawn path degrades to active:false when caffeinate is missing, via the manager's exit-driven bookkeeping", async () => {
    // Exercises the same real-spawn ENOENT path as above, but through the
    // full manager (using a spawnChild that wraps a real child_process.spawn
    // of a bogus binary, mirroring defaultSpawnChild's own shape) — proves
    // the fix closes the loop end-to-end: unexpected "exit" (from the error
    // path) still drives the single-respawn-then-give-up guard and
    // eventually active:false, rather than active staying true forever.
    const spawnChild = (_argv: string[]): SleepInhibitChild => {
      const realChild = spawn("falcon-sleep-inhibit-definitely-not-a-real-binary", [], {
        stdio: "ignore",
      });
      return wrapChildProcess(realChild);
    };
    const manager = createSleepInhibitManager({ platform: "darwin", daemonPid: 1, spawnChild });

    manager.applyMode("always");
    expect(manager.getState().active).toBe(true); // momentarily optimistic, same as a real spawn

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const check = () => {
        if (!manager.getState().active) return resolve();
        if (Date.now() > deadline) return reject(new Error("active never went false"));
        setTimeout(check, 20);
      };
      check();
    });

    expect(manager.getState().active).toBe(false);
  });

  it("getState reflects the current state without re-applying anything", () => {
    const fake = makeFakeChild();
    const spawnChild = vi.fn().mockReturnValue(fake.child);
    const manager = createSleepInhibitManager({ platform: "darwin", daemonPid: 1, spawnChild });

    manager.applyMode("onPower");
    expect(manager.getState()).toEqual({
      supported: true,
      platform: "darwin",
      mode: "onPower",
      active: true,
    });
    expect(spawnChild).toHaveBeenCalledTimes(1);
  });
});
