import { describe, expect, it } from "vitest";
import { createMockRunPanelActions } from "../mock-source";

describe("createMockRunPanelActions", () => {
  it("getConfig returns a configured setupScript/runScript", async () => {
    const actions = createMockRunPanelActions("mach-1");
    const config = await actions.getConfig("/repo");
    expect(config.runScript).toBe("npm run dev");
    expect(config.setupScript).toBe("npm install");
  });

  it("status starts as run:none / setup:not-run", async () => {
    const actions = createMockRunPanelActions("mach-1");
    const status = await actions.status("/repo");
    expect(status).toEqual({ run: { state: "none" }, setup: { state: "not-run" } });
  });

  it("start() transitions run state to running, then status reflects it", async () => {
    const actions = createMockRunPanelActions("mach-1");
    const result = await actions.start("/repo");
    expect(result.started).toBe(true);
    expect(result.method).toBe("tmux");

    const status = await actions.status("/repo");
    expect(status.run.state).toBe("running");
    expect(status.run.pid).toBeDefined();
    expect(status.run.logTail).toBeDefined();
  });

  it("start() while already running returns alreadyRunning:true and does not restart", async () => {
    const actions = createMockRunPanelActions("mach-1");
    const first = await actions.start("/repo");
    const second = await actions.start("/repo");

    expect(first).toEqual({
      started: true,
      method: "tmux",
      pid: 4242,
      tmuxSessionName: "falcon-run-demo",
    });
    expect(second.started).toBe(false);
    expect(second.alreadyRunning).toBe(true);
  });

  it("stop() transitions a running instance back to stopped", async () => {
    const actions = createMockRunPanelActions("mach-1");
    await actions.start("/repo");
    const result = await actions.stop("/repo");
    expect(result).toEqual({ stopped: true, wasRunning: true });

    const status = await actions.status("/repo");
    expect(status.run.state).toBe("stopped");
  });

  it("stop() when nothing is running returns stopped:false wasRunning:false", async () => {
    const actions = createMockRunPanelActions("mach-1");
    const result = await actions.stop("/repo");
    expect(result).toEqual({ stopped: false, wasRunning: false });
  });

  it("setup() transitions to running immediately, then to succeeded shortly after", async () => {
    const actions = createMockRunPanelActions("mach-1");
    const result = await actions.setup("/repo");
    expect(result).toEqual({ started: true });

    const runningStatus = await actions.status("/repo");
    expect(runningStatus.setup.state).toBe("running");

    await new Promise((resolve) => setTimeout(resolve, 900));
    const finalStatus = await actions.status("/repo");
    expect(finalStatus.setup.state).toBe("succeeded");
    expect(finalStatus.setup.exitCode).toBe(0);
    expect(finalStatus.setup.logTail).toBeDefined();
  });

  it("each call to createMockRunPanelActions has independent state", async () => {
    const a = createMockRunPanelActions("mach-1");
    const b = createMockRunPanelActions("mach-2");

    await a.start("/repo");

    expect((await a.status("/repo")).run.state).toBe("running");
    expect((await b.status("/repo")).run.state).toBe("none");
  });
});
