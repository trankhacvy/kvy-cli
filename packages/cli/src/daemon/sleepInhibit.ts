/**
 * `sleepInhibit.get`/`sleepInhibit.set` machine RPC enforcement (docs/features/
 * sleep-inhibit.md, docs/competitive-notes-omnara.md #12 "Sleep-inhibit
 * control"): owns the OS "don't sleep" assertion subprocess lifecycle for a
 * per-machine tri-state policy (Off / While on Power / Always), macOS-only
 * for MVP (`caffeinate` is a macOS binary — every other platform reports
 * `supported: false` and never spawns anything).
 *
 * argv mapping is a fixed table, never string interpolation — `mode` is
 * attacker-influenceable input (it drives a subprocess spawn straight off a
 * sealed RPC payload) and must map enum → fixed argv array, run via
 * `child_process.spawn` (never a shell), same discipline `gitExec.ts`
 * already follows:
 *   - "off"     -> no child.
 *   - "onPower" -> ["caffeinate", "-s", "-w", "<daemonPid>"] — `-s` is a
 *                  system-sleep assertion that macOS itself only honors
 *                  while on AC power, so "While on Power" needs no battery
 *                  polling here.
 *   - "always"  -> ["caffeinate", "-i", "-w", "<daemonPid>"] — an idle-sleep
 *                  assertion held regardless of power source.
 *
 * The `-w <daemon pid>` tether on BOTH flags is the leak-safety guard in
 * place of any `daemon/doctor.ts`/`markers.ts` reaping: `markers.ts`
 * classifies processes argv-first by the Falcon entrypoint token, so a raw
 * `caffeinate` child could never be recognized as Falcon-owned there. `-w`
 * instead makes macOS itself release the assertion the instant the tethered
 * pid exits — daemon crash (SIGKILL) included — so a leaked caffeinate
 * child that outlives the daemon is structurally impossible, not just
 * best-effort cleaned up. `stop()` is the polite, immediate-release path for
 * a graceful shutdown; the tether is the crash-safety net underneath it.
 *
 * Functional caveat (not a bug, documented in the web card's help text):
 * `caffeinate` cannot prevent lid-closed (clamshell) sleep on battery power
 * — "Always" still won't keep a MacBook awake with the lid closed unless
 * it's plugged in.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { SleepInhibitMode, SleepInhibitState } from "@falcon/wire";
import type { Logger } from "../logger.js";

/** Minimal shape a spawned sleep-inhibit child needs to expose — injectable so tests never spawn a real `caffeinate`. */
export interface SleepInhibitChild {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

/** Exported for `sleepInhibit.test.ts`'s real-`child_process.spawn` ENOENT regression test — not part of the module's public dep-injection surface. */
export function wrapChildProcess(child: ChildProcess): SleepInhibitChild {
  return {
    pid: child.pid,
    kill: (signal) => child.kill(signal),
    onExit: (cb) => {
      // A child that spawns and later dies fires "exit" (with a real
      // code/signal). A child that never actually started — e.g. `caffeinate`
      // missing from PATH (ENOENT) — does NOT fire "exit" at all; Node fires
      // "error" instead (verified: `spawn("does-not-exist", ...)` emits
      // "error"+"close" but never "exit"). Both cases mean the same thing to
      // this manager ("the assertion is no longer held"), so listen to both
      // and fire the callback exactly once, whichever comes first — otherwise
      // a missing-binary machine would report `active: true` forever, with
      // the single-respawn-then-give-up guard never engaging since it's keyed
      // off this same callback.
      let fired = false;
      const fire = (code: number | null, signal: NodeJS.Signals | null) => {
        if (fired) return;
        fired = true;
        cb(code, signal);
      };
      child.once("exit", (code, signal) => fire(code, signal));
      child.once("error", () => fire(null, null));
    },
  };
}

export interface SleepInhibitManagerDeps {
  logger?: Logger;
  /** Defaults to `process.platform` — overridable so tests can exercise the non-darwin path without needing to actually run on Linux/Windows. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.pid` — the pid the `-w` tether is anchored to. */
  daemonPid?: number;
  /** Spawns the sleep-inhibit child for a given fixed argv. Defaults to a real, non-detached `child_process.spawn` (`stdio: "ignore"` — same process group as the daemon, so a SIGKILL'd daemon takes it down too, independent of the `-w` tether). Injectable for tests. */
  spawnChild?: (argv: string[]) => SleepInhibitChild;
}

export interface SleepInhibitManager {
  /** Applies (or re-applies) `mode`: kills any current child if the mode actually changed, then spawns per the fixed argv table. Never throws — a spawn failure degrades to `active: false` (logged as a warning). */
  applyMode(mode: SleepInhibitMode): SleepInhibitState;
  /** Current state without changing anything. */
  getState(): SleepInhibitState;
  /** Kills any current child immediately (the polite release path for graceful shutdown — the `-w` tether is the crash-safety net underneath it) and makes every `applyMode` call after this one a safe no-op. Idempotent — calling `stop()` again is safe. */
  stop(): void;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function defaultSpawnChild(argv: string[]): SleepInhibitChild {
  const [command, ...args] = argv;
  if (!command) throw new Error("sleepInhibit: empty argv");
  const child = spawn(command, args, { stdio: "ignore", detached: false });
  return wrapChildProcess(child);
}

/** Fixed enum -> argv table — never string-built. `daemonPid` is interpolated as a plain positional argv element (an array entry), not into a shell command string. */
function argvFor(mode: SleepInhibitMode, daemonPid: number): string[] | null {
  switch (mode) {
    case "off":
      return null;
    case "onPower":
      return ["caffeinate", "-s", "-w", String(daemonPid)];
    case "always":
      return ["caffeinate", "-i", "-w", String(daemonPid)];
    default:
      return null;
  }
}

export function createSleepInhibitManager(deps: SleepInhibitManagerDeps = {}): SleepInhibitManager {
  const logger = deps.logger ?? noopLogger;
  const platform = deps.platform ?? process.platform;
  const daemonPid = deps.daemonPid ?? process.pid;
  const spawnChild = deps.spawnChild ?? defaultSpawnChild;
  const supported = platform === "darwin";

  let mode: SleepInhibitMode = "off";
  let active = false;
  let child: SleepInhibitChild | null = null;
  let respawnedAfterUnexpectedExit = false;
  let stopped = false;

  function state(): SleepInhibitState {
    return { supported, platform, mode: supported ? mode : "off", active: supported && active };
  }

  function killCurrentChild(): void {
    if (!child) return;
    try {
      child.kill("SIGTERM"); // caffeinate exits immediately on SIGTERM — no escalation needed.
    } catch (error) {
      logger.warn("[sleep-inhibit] failed to kill existing child", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    child = null;
  }

  function spawnFor(nextMode: SleepInhibitMode): void {
    const argv = argvFor(nextMode, daemonPid);
    if (!argv) {
      active = false;
      return;
    }
    try {
      const spawned = spawnChild(argv);
      child = spawned;
      active = true;
      // NOTE: `respawnedAfterUnexpectedExit` is deliberately NOT reset here —
      // it's only cleared by an explicit `applyMode` call (a genuine new
      // policy application re-arms the single-respawn budget). Resetting it
      // on every successful spawn would let the automatic respawn below
      // reset its own budget and retry forever, defeating the
      // single-respawn-then-give-up guard.
      spawned.onExit((code, signal) => {
        // Only react if this is still the current child and the manager
        // hasn't been deliberately stopped/switched to "off" — `killCurrentChild`
        // clears `child` to null before killing, so a stop()-triggered exit
        // never reaches here.
        if (child !== spawned) return;
        logger.warn("[sleep-inhibit] caffeinate child exited unexpectedly", { code, signal });
        child = null;
        active = false;
        if (stopped || mode === "off") return;
        if (respawnedAfterUnexpectedExit) {
          // Already tried one automatic respawn for this run — give up
          // rather than risk a crash-loop hammering spawn (e.g. a Mac
          // missing /usr/bin/caffeinate, or a SIP oddity).
          return;
        }
        respawnedAfterUnexpectedExit = true;
        spawnFor(mode);
      });
    } catch (error) {
      active = false;
      child = null;
      logger.warn("[sleep-inhibit] failed to spawn caffeinate", {
        mode: nextMode,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function applyMode(nextMode: SleepInhibitMode): SleepInhibitState {
    // Once stop() has run, this manager instance is done for the process's
    // lifetime — a further applyMode call is a safe no-op rather than
    // reviving a child post-shutdown (the manager is created fresh per
    // daemon boot in commands.ts, so nothing legitimately calls applyMode
    // after stop() in practice; this is a defensive guarantee, not a
    // reachable production path).
    if (stopped) return state();
    if (!supported) {
      mode = "off";
      active = false;
      return state();
    }
    if (nextMode === mode && (nextMode === "off" || (child && active))) {
      return state();
    }
    killCurrentChild();
    mode = nextMode;
    respawnedAfterUnexpectedExit = false;
    spawnFor(nextMode);
    return state();
  }

  function stop(): void {
    stopped = true;
    killCurrentChild();
    active = false;
  }

  return {
    applyMode,
    getState: state,
    stop,
  };
}
