import { describe, expect, it } from "vitest";
import { announceRemoteControl } from "./announceRemoteControl.js";

describe("announceRemoteControl", () => {
  it("produces a valid mode-switch envelope declaring remote control by the client", () => {
    const envelope = announceRemoteControl();
    expect(envelope.role).toBe("agent");
    expect(envelope.ev).toEqual({ t: "mode-switch", control: "remote", by: "client" });
  });

  it("mints a fresh id on every call", () => {
    const first = announceRemoteControl();
    const second = announceRemoteControl();
    expect(first.id).not.toBe(second.id);
  });
});
