import { useMemo } from "react";
import type { RunConfig, RunPanelActions, RunStatusSnapshot, UseRunPanelActions } from "./types";

/**
 * The Setup/Run panel's default data source — mirrors `features/git-diff/
 * mock-source.ts`'s role: `apiSocket`/a live per-machine crypto client
 * aren't wired into every screen yet, so this simulates the daemon's
 * `workspace.getConfig`/`run.*` RPCs against small, closured-over
 * in-memory state, kept to the same call signatures (`RunPanelActions`) so
 * swapping in the real `machineRpcToRunPanelActions` later is a one-line
 * change at the call site.
 *
 * Unlike `git-diff`'s stateless mock (every call returns the same fixed
 * fixture), this one simulates real start/stop/setup *transitions* —
 * `start()` flips the run state to "running", `stop()` flips it back,
 * `setup()` transitions through "running" to a terminal state after a short
 * delay — since the whole point of this panel is showing those
 * transitions happen.
 */

const LATENCY_MS = 200;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createMockRunPanelActions(_machineId: string): RunPanelActions {
  const config: RunConfig = {
    baseRef: "main",
    remote: "origin",
    setupScript: "npm install",
    runScript: "npm run dev",
  };

  let run: RunStatusSnapshot["run"] = { state: "none" };
  let setup: RunStatusSnapshot["setup"] = { state: "not-run" };

  return {
    async getConfig(_worktree) {
      await delay(LATENCY_MS);
      return config;
    },

    async start(_worktree) {
      await delay(LATENCY_MS);
      if (!config.runScript) return { started: false };
      if (run.state === "running") {
        return {
          started: false,
          alreadyRunning: true,
          method: run.method,
          pid: run.pid,
          tmuxSessionName: undefined,
        };
      }
      run = {
        state: "running",
        pid: 4242,
        method: "tmux",
        startedAt: Date.now(),
        logTail: "Server listening on http://localhost:3000\n",
      };
      return { started: true, method: "tmux", pid: 4242, tmuxSessionName: "falcon-run-demo" };
    },

    async stop(_worktree) {
      await delay(LATENCY_MS);
      if (run.state !== "running") return { stopped: false, wasRunning: false };
      run = { state: "stopped", logTail: run.logTail };
      return { stopped: true, wasRunning: true };
    },

    async status(_worktree) {
      await delay(LATENCY_MS);
      return { run, setup };
    },

    async setup(_worktree) {
      await delay(LATENCY_MS);
      if (!config.setupScript) return { started: false };
      const startedAt = Date.now();
      setup = { state: "running", startedAt };
      // Simulates the real daemon's async setup runner (`setupScript.ts`)
      // transitioning to a terminal state some time after this call
      // resolves — this mock's `status()` call picks up whichever state is
      // current whenever it's next polled, same as the real RPC.
      setTimeout(() => {
        setup = {
          state: "succeeded",
          exitCode: 0,
          startedAt,
          finishedAt: Date.now(),
          logTail: "added 42 packages in 3s\n",
        };
      }, 800);
      return { started: true };
    },
  };
}

/** `useMemo`'d on `machineId` so a real hook backed by a live `RunPanelActions` client (which shouldn't reseal/reconnect every render) can be swapped in without changing this call site's shape. */
export const useMockRunPanelActions: UseRunPanelActions = (machineId) =>
  useMemo(() => createMockRunPanelActions(machineId), [machineId]);
