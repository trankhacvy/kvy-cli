import { describe, expect, it } from "vitest";
import { isSessionRoute, sidebarCollapsible } from "./app-shell";

/**
 * `AppShell` itself is hook-heavy (`usePathname`) and can't be rendered
 * directly under this package's `environment: "node"` vitest config (same
 * constraint documented in `(protected)/layout.test.ts`), so these tests
 * exercise the pure route-classification helpers it's built from —
 * `isSessionRoute`/`sidebarCollapsible` decide whether collapsing the left
 * nav shrinks it to an icon rail or fully hides it for a full-width session
 * view (competitive-notes-omnara.md #20).
 */
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

  it("is false for the new-session wizard", () => {
    expect(isSessionRoute("/dashboard/session/new/")).toBe(false);
  });

  it("is false for the sessions list and other non-session routes", () => {
    expect(isSessionRoute("/dashboard/")).toBe(false);
    expect(isSessionRoute("/signin/")).toBe(false);
  });
});

describe("sidebarCollapsible", () => {
  it("fully hides the nav (offcanvas) on a session timeline route", () => {
    expect(sidebarCollapsible("/dashboard/session/abc-123/")).toBe("offcanvas");
  });

  it("fully hides the nav on a session's git panel route", () => {
    expect(sidebarCollapsible("/dashboard/session/abc-123/git/")).toBe("offcanvas");
  });

  it("fully hides the nav on an unmanaged session route", () => {
    expect(sidebarCollapsible("/dashboard/session/unmanaged/abc-123/")).toBe("offcanvas");
  });

  it("shrinks to an icon rail everywhere else", () => {
    expect(sidebarCollapsible("/dashboard/")).toBe("icon");
    expect(sidebarCollapsible("/dashboard/session/new/")).toBe("icon");
    expect(sidebarCollapsible("/signin/")).toBe("icon");
  });
});
