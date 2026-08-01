import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MachineOnlineState } from "@/lib/use-machine-online";
import { MachineOfflineNotice } from "./machine-offline-notice";

describe("MachineOfflineNotice", () => {
  it("renders nothing when the machine is online", () => {
    const state: MachineOnlineState = {
      availability: "online",
      isKnownUnavailable: false,
      reason: null,
    };
    expect(renderToStaticMarkup(createElement(MachineOfflineNotice, { state }))).toBe("");
  });

  it("renders nothing when the machine's state is unknown — unknown must never look like offline", () => {
    const state: MachineOnlineState = {
      availability: "unknown",
      isKnownUnavailable: false,
      reason: null,
    };
    expect(renderToStaticMarkup(createElement(MachineOfflineNotice, { state }))).toBe("");
  });

  it("shows the offline reason with role=status when confidently offline", () => {
    const state: MachineOnlineState = {
      availability: "offline",
      isKnownUnavailable: true,
      reason: "This project's machine is offline right now.",
    };
    const html = renderToStaticMarkup(createElement(MachineOfflineNotice, { state }));
    expect(html).toContain("This project&#x27;s machine is offline right now.");
    expect(html).toContain('role="status"');
  });

  it("shows the distinct needs-reauth copy", () => {
    const state: MachineOnlineState = {
      availability: "needs-reauth",
      isKnownUnavailable: true,
      reason: "This project's machine needs to sign in again. Run `kvy auth login` there.",
    };
    const html = renderToStaticMarkup(createElement(MachineOfflineNotice, { state }));
    expect(html).toContain("sign in again");
  });
});
