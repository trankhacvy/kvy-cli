import { describe, expect, it } from "vitest";
import { isSessionOrphaned, STALE_SESSION_MACHINE_WINDOW_MS } from "./staleSessions.js";

const NOW = Date.now();

function sessionAt(overrides: {
  status?: string;
  machineId?: string | null;
  updatedAgoMs?: number;
}) {
  return {
    status: overrides.status ?? "active",
    machineId: overrides.machineId === undefined ? "machine-1" : overrides.machineId,
    updatedAt: new Date(NOW - (overrides.updatedAgoMs ?? 0)),
  };
}

describe("isSessionOrphaned (known-issues.md #8)", () => {
  it("is false when the machine has heartbeated recently, regardless of session quiet time", () => {
    const lastSeenAt = new Date(NOW - 30_000); // 30s ago — well within the window
    expect(isSessionOrphaned(sessionAt({ updatedAgoMs: 10 * 60_000 }), lastSeenAt, NOW)).toBe(
      false,
    );
  });

  it("is false when the machine is stale but the session itself was touched recently", () => {
    const lastSeenAt = new Date(NOW - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    expect(isSessionOrphaned(sessionAt({ updatedAgoMs: 1_000 }), lastSeenAt, NOW)).toBe(false);
  });

  it("is true when both the machine and the session have been silent past the window", () => {
    const lastSeenAt = new Date(NOW - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    expect(
      isSessionOrphaned(
        sessionAt({ updatedAgoMs: STALE_SESSION_MACHINE_WINDOW_MS + 60_000 }),
        lastSeenAt,
        NOW,
      ),
    ).toBe(true);
  });

  it("is false right at the boundary (exactly the window, not past it)", () => {
    const lastSeenAt = new Date(NOW - STALE_SESSION_MACHINE_WINDOW_MS);
    expect(
      isSessionOrphaned(
        sessionAt({ updatedAgoMs: STALE_SESSION_MACHINE_WINDOW_MS }),
        lastSeenAt,
        NOW,
      ),
    ).toBe(false);
  });

  it("is false for a session that isn't active", () => {
    const lastSeenAt = new Date(NOW - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    expect(
      isSessionOrphaned(
        sessionAt({ status: "ended", updatedAgoMs: STALE_SESSION_MACHINE_WINDOW_MS + 60_000 }),
        lastSeenAt,
        NOW,
      ),
    ).toBe(false);
  });

  it("is false for a session with no machineId", () => {
    const lastSeenAt = new Date(NOW - (STALE_SESSION_MACHINE_WINDOW_MS + 60_000));
    expect(
      isSessionOrphaned(
        sessionAt({ machineId: null, updatedAgoMs: STALE_SESSION_MACHINE_WINDOW_MS + 60_000 }),
        lastSeenAt,
        NOW,
      ),
    ).toBe(false);
  });

  it("is false when the machine has never heartbeated (null lastSeenAt) — no confident signal", () => {
    expect(
      isSessionOrphaned(
        sessionAt({ updatedAgoMs: STALE_SESSION_MACHINE_WINDOW_MS + 60_000 }),
        null,
        NOW,
      ),
    ).toBe(false);
  });

  it("is false when the machine lastSeenAt is unknown (undefined — machineId not in the caller's map)", () => {
    expect(
      isSessionOrphaned(
        sessionAt({ updatedAgoMs: STALE_SESSION_MACHINE_WINDOW_MS + 60_000 }),
        undefined,
        NOW,
      ),
    ).toBe(false);
  });
});
