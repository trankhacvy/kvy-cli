import { describe, expect, it } from "vitest";
import { interpretRemoteModeKeypress, type RemoteModeKeypressState } from "./remoteModeKeypress.js";

const idle: RemoteModeKeypressState = { confirmationMode: null, actionInProgress: null };

describe("interpretRemoteModeKeypress", () => {
  it("space from idle arms the switch confirmation", () => {
    expect(interpretRemoteModeKeypress(idle, " ")).toEqual({ action: "confirm-switch" });
  });

  it("a second space while switch is armed confirms the switch", () => {
    const state: RemoteModeKeypressState = { confirmationMode: "switch", actionInProgress: null };
    expect(interpretRemoteModeKeypress(state, " ")).toEqual({ action: "switch" });
  });

  it("Ctrl-T switches immediately with no confirmation, from idle or armed", () => {
    expect(interpretRemoteModeKeypress(idle, "t", { ctrl: true })).toEqual({ action: "switch" });
    expect(
      interpretRemoteModeKeypress({ confirmationMode: "exit", actionInProgress: null }, "t", {
        ctrl: true,
      }),
    ).toEqual({ action: "switch" });
  });

  it("Ctrl-C from idle arms the exit confirmation", () => {
    expect(interpretRemoteModeKeypress(idle, "c", { ctrl: true })).toEqual({ action: "confirm-exit" });
  });

  it("a second Ctrl-C while exit is armed confirms the exit", () => {
    const state: RemoteModeKeypressState = { confirmationMode: "exit", actionInProgress: null };
    expect(interpretRemoteModeKeypress(state, "c", { ctrl: true })).toEqual({ action: "exit" });
  });

  it("Ctrl-C while switch is armed re-arms exit rather than confirming switch", () => {
    const state: RemoteModeKeypressState = { confirmationMode: "switch", actionInProgress: null };
    expect(interpretRemoteModeKeypress(state, "c", { ctrl: true })).toEqual({ action: "confirm-exit" });
  });

  it("any other key while a confirmation is armed resets it", () => {
    const state: RemoteModeKeypressState = { confirmationMode: "switch", actionInProgress: null };
    expect(interpretRemoteModeKeypress(state, "x")).toEqual({ action: "reset" });
  });

  it("an unrelated key from idle with no confirmation armed does nothing", () => {
    expect(interpretRemoteModeKeypress(idle, "x")).toEqual({ action: "none" });
  });

  it("every keypress is ignored while an action is already in progress", () => {
    const state: RemoteModeKeypressState = { confirmationMode: null, actionInProgress: "switching" };
    expect(interpretRemoteModeKeypress(state, " ")).toEqual({ action: "none" });
    expect(interpretRemoteModeKeypress(state, "t", { ctrl: true })).toEqual({ action: "none" });
    expect(interpretRemoteModeKeypress(state, "c", { ctrl: true })).toEqual({ action: "none" });
  });
});
