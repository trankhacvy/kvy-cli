import { describe, expect, it, vi } from "vitest";
import {
  canConfirmRevoke,
  clearRevokeConfirm,
  type RevokeConfirmId,
  requestRevoke,
} from "./devices-revoke-state";

describe("requestRevoke / clearRevokeConfirm", () => {
  it("requestRevoke shows the confirm affordance for that session's id", () => {
    expect(requestRevoke("sess-1")).toBe("sess-1");
  });

  it("clearRevokeConfirm always returns to no row confirming", () => {
    expect(clearRevokeConfirm()).toBeNull();
  });
});

describe("canConfirmRevoke", () => {
  it("passes only for the row currently showing the confirm affordance", () => {
    expect(canConfirmRevoke("sess-1", "sess-1")).toBe(true);
  });

  it("rejects a different row's id (e.g. a stale Confirm click after switching rows)", () => {
    expect(canConfirmRevoke("sess-1", "sess-2")).toBe(false);
  });

  it("rejects any row when nothing has been requested", () => {
    expect(canConfirmRevoke(null, "sess-1")).toBe(false);
  });
});

/**
 * End-to-end (at the logic level) reproduction of `DevicesSection`'s
 * requestRevokeClick -> confirmRevoke/Cancel wiring, using a fake
 * `revokeSession` call in place of the real network call — this package has
 * no jsdom/`@testing-library/react` wired up, so a real click can't be
 * simulated (see `devices-revoke-state.ts`'s own doc comment on the same
 * constraint).
 */
describe("two-click revoke flow", () => {
  it("requires a second (confirm) click before the revoke API is ever called", () => {
    const revokeSession = vi.fn();
    let confirmId: RevokeConfirmId = null;

    // First click ("Log out") — only requests confirmation, no API call.
    confirmId = requestRevoke("sess-1");
    expect(confirmId).toBe("sess-1");
    expect(revokeSession).not.toHaveBeenCalled();

    // Second click ("Confirm") — the gate passes, and only now does the
    // real call fire, mirroring `confirmRevoke`'s guard + clear + call order.
    expect(canConfirmRevoke(confirmId, "sess-1")).toBe(true);
    confirmId = clearRevokeConfirm();
    revokeSession("sess-1");

    expect(revokeSession).toHaveBeenCalledExactlyOnceWith("sess-1");
    expect(confirmId).toBeNull();
  });

  it("cancel leaves the session intact — no revoke call, and the row resets", () => {
    const revokeSession = vi.fn();
    let confirmId: RevokeConfirmId = requestRevoke("sess-1");

    // "Cancel" — same transition as a post-confirm reset, but the revoke
    // call is never made on this path.
    confirmId = clearRevokeConfirm();

    expect(confirmId).toBeNull();
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("a Confirm click never reaches the API for a row that was cancelled first", () => {
    const revokeSession = vi.fn();
    let confirmId: RevokeConfirmId = requestRevoke("sess-1");
    confirmId = clearRevokeConfirm(); // Cancel.

    // If a stray "Confirm" click still landed after Cancel reset the row,
    // the gate must refuse it — there is nothing left to confirm.
    if (canConfirmRevoke(confirmId, "sess-1")) {
      revokeSession("sess-1");
    }

    expect(revokeSession).not.toHaveBeenCalled();
  });
});
