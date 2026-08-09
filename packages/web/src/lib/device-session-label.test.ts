import { describe, expect, it } from "vitest";
import { clientKindLabel, deviceSessionLabel } from "./device-session-label";

describe("clientKindLabel", () => {
  it("maps every known client kind to a friendly label", () => {
    expect(clientKindLabel("web")).toBe("Web browser");
    expect(clientKindLabel("cli-daemon")).toBe("CLI daemon");
    expect(clientKindLabel("cli-session")).toBe("CLI session");
    expect(clientKindLabel("cloud-sandbox")).toBe("Cloud sandbox");
  });

  it("falls back to the raw string for an unknown client kind", () => {
    expect(clientKindLabel("future-kind")).toBe("future-kind");
  });
});

describe("deviceSessionLabel", () => {
  it("prefers a custom/computed label over the client-kind fallback", () => {
    expect(deviceSessionLabel({ label: "Chrome on macOS", clientKind: "web" })).toBe(
      "Chrome on macOS",
    );
  });

  it("falls back to the friendly client-kind label when there's no label", () => {
    expect(deviceSessionLabel({ label: null, clientKind: "cli-daemon" })).toBe("CLI daemon");
  });
});
