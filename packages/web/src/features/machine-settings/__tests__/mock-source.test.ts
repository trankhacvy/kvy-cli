import { describe, expect, it } from "vitest";
import { createMockMachineSettingsActions } from "../mock-source";

describe("createMockMachineSettingsActions", () => {
  it("a darwin machine starts supported, mode off, inactive", async () => {
    const actions = createMockMachineSettingsActions("mach-darwin");
    const state = await actions.fetchSleepInhibit();

    expect(state).toEqual({ supported: true, platform: "darwin", mode: "off", active: false });
  });

  it("a linux machine reports supported:false and never changes mode", async () => {
    const actions = createMockMachineSettingsActions("mach-linux");

    const before = await actions.fetchSleepInhibit();
    expect(before).toEqual({ supported: false, platform: "linux", mode: "off", active: false });

    const afterSet = await actions.setSleepInhibit("always");
    expect(afterSet).toEqual({ supported: false, platform: "linux", mode: "off", active: false });
  });

  it("setSleepInhibit on a supported machine round-trips the new mode and updates active", async () => {
    const actions = createMockMachineSettingsActions("mach-darwin");

    const afterSet = await actions.setSleepInhibit("always");
    expect(afterSet).toEqual({ supported: true, platform: "darwin", mode: "always", active: true });

    const refetched = await actions.fetchSleepInhibit();
    expect(refetched).toEqual(afterSet);
  });

  it("setSleepInhibit('off') reports active:false", async () => {
    const actions = createMockMachineSettingsActions("mach-darwin");
    await actions.setSleepInhibit("onPower");

    const afterOff = await actions.setSleepInhibit("off");
    expect(afterOff).toEqual({ supported: true, platform: "darwin", mode: "off", active: false });
  });

  it("state is independent per createMockMachineSettingsActions call, even for the same machineId", async () => {
    const first = createMockMachineSettingsActions("mach-darwin");
    const second = createMockMachineSettingsActions("mach-darwin");

    await first.setSleepInhibit("always");

    expect((await second.fetchSleepInhibit()).mode).toBe("off");
  });
});
