import { describe, expect, it } from "vitest";
import { isSessionRoute } from "./app-shell";

// `AppShell` is hook-heavy and can't render under `environment: "node"`, so these tests
// exercise `isSessionRoute` directly — the pure helper that decides full-width treatment.
describe("isSessionRoute", () => {
  it("is true for a session timeline route", () => {
    expect(isSessionRoute("/dashboard/session/abc-123/")).toBe(true);
  });

  it("is true for a session's git panel route", () => {
    expect(isSessionRoute("/dashboard/session/abc-123/git/")).toBe(true);
  });

  it("is true for an unmanaged session route", () => {
    expect(isSessionRoute("/dashboard/session/unmanaged/abc-123/")).toBe(true);
  });

  it("is false for the sessions list and other non-session routes", () => {
    expect(isSessionRoute("/dashboard/")).toBe(false);
    expect(isSessionRoute("/signin/")).toBe(false);
  });
});
