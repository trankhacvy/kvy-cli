import { describe, expect, it } from "vitest";
import { isSessionRoute } from "./app-shell";

/**
 * `AppShell` itself is hook-heavy (`usePathname`) and can't be rendered
 * directly under this package's `environment: "node"` vitest config (same
 * constraint documented in `(protected)/layout.test.ts`), so these tests
 * exercise the pure route-classification helper it's built from —
 * `isSessionRoute` decides whether the content area gets full-width
 * treatment. The sidebar itself always collapses to an icon rail now
 * (manual toggle only, docs/workspace-nav-redesign-plan.md decision #4) —
 * it's no longer route-dependent.
 *
 * B5 (new-session-from-web redesign, see the task's own header comment):
 * `/dashboard/session/new/` no longer exists — the standalone new-session
 * wizard route was retired in favor of the workspace-row `+` dialog
 * (`features/session-list/components/new-session-panel.tsx`), so this
 * helper no longer special-cases it.
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

  it("is false for the sessions list and other non-session routes", () => {
    expect(isSessionRoute("/dashboard/")).toBe(false);
    expect(isSessionRoute("/signin/")).toBe(false);
  });
});
