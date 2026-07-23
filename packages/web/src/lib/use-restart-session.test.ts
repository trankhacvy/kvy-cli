import type { SessionRow } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import { isRestartEnabled, restartDisabledReason } from "./use-restart-session";

/**
 * The Restart menu item's enable/disable matrix
 * (docs/features/session-lifecycle-actions.md Phase 6) — Restart is never
 * clickable for a machine-less session, an offline machine, or an already-
 * archived row. Both `SessionCardActions` and the timeline's
 * `SessionActionsMenu` drive their item's `disabled`/`title` off these same
 * two pure functions.
 */
function params(overrides: {
  machineId?: string | null;
  machineOnline?: boolean;
  status?: SessionRow["status"];
}) {
  return {
    machineId: "mach-1",
    machineOnline: true,
    status: "active" as SessionRow["status"],
    ...overrides,
  };
}

describe("isRestartEnabled", () => {
  it("is enabled when the session has an online owning machine and isn't archived", () => {
    expect(isRestartEnabled(params({}))).toBe(true);
  });

  it("is disabled when there's no owning machine", () => {
    expect(isRestartEnabled(params({ machineId: null }))).toBe(false);
  });

  it("is disabled when the owning machine is offline", () => {
    expect(isRestartEnabled(params({ machineOnline: false }))).toBe(false);
  });

  it("is disabled once the session is archived, even with an online machine", () => {
    expect(isRestartEnabled(params({ status: "archived" }))).toBe(false);
  });

  it("is enabled for a live but non-active status (e.g. compacted)", () => {
    expect(isRestartEnabled(params({ status: "compacted" }))).toBe(true);
  });
});

describe("restartDisabledReason", () => {
  it("is null when Restart is actually enabled", () => {
    expect(restartDisabledReason(params({}))).toBeNull();
  });

  it("explains an archived row first, even if the machine is also offline/missing", () => {
    expect(restartDisabledReason(params({ status: "archived", machineId: null }))).toMatch(
      /restore/i,
    );
  });

  it("explains a missing owning machine", () => {
    expect(restartDisabledReason(params({ machineId: null }))).toMatch(/no owning machine/i);
  });

  it("explains an offline owning machine", () => {
    expect(restartDisabledReason(params({ machineOnline: false }))).toMatch(/offline/i);
  });
});
