import { describe, expect, it } from "vitest";
import { type Gate, nextGate, type PairDetails, resolvePairGate } from "./pair-gate";

// known-issues.md #14 / require-auth.tsx's `ensureSession`: `resolvePairGate`
// is the pairing page's gating decision pulled out of its effect so it's
// testable without mounting React/next/navigation (this package has no DOM
// test environment — see `require-auth.test.ts`'s `shouldRedirectToSignin`
// for the same technique).
describe("resolvePairGate", () => {
  it("bounces to signin immediately when there's no local identity, without attempting a refresh", async () => {
    let silentRefreshCalled = false;
    const gate = await resolvePairGate(null, {
      isSignedIn: () => false,
      silentRefresh: async () => {
        silentRefreshCalled = true;
        return "ok";
      },
    });
    expect(gate).toBe("signin");
    expect(silentRefreshCalled).toBe(false);
  });

  it("lands on the confirm screen when already signed in, without attempting a refresh", async () => {
    const gate = await resolvePairGate(
      { accountId: "acct_1" },
      {
        isSignedIn: () => true,
        silentRefresh: async () => {
          throw new Error("silentRefresh should not run when isSignedIn() is already true");
        },
      },
    );
    expect(gate).toBe("confirm");
  });

  it("a signed-in-but-token-expired visitor lands on the confirm screen once silentRefresh succeeds", async () => {
    const gate = await resolvePairGate(
      { accountId: "acct_1" },
      {
        isSignedIn: () => false,
        silentRefresh: async () => "ok",
      },
    );
    expect(gate).toBe("confirm");
  });

  it("only bounces to signin when identity exists but silentRefresh also fails", async () => {
    const gate = await resolvePairGate(
      { accountId: "acct_1" },
      {
        isSignedIn: () => false,
        silentRefresh: async () => "signed-out",
      },
    );
    expect(gate).toBe("signin");
  });

  it("bounces to signin (not confirm) when silentRefresh can't reach the server", async () => {
    const gate = await resolvePairGate(
      { accountId: "acct_1" },
      {
        isSignedIn: () => false,
        silentRefresh: async () => "unreachable",
      },
    );
    expect(gate).toBe("signin");
  });
});

// auth-ux-overhaul-fix-plan.md Fix 10: the crypto-readiness effect only ever demoted
// `confirm` -> `needs-keys`, with no inverse — a user who fetched their keys via
// `RequestKeysPanel` was left stranded on the screen they'd just finished. `nextGate` is
// the reversible version, extracted to a pure function so both transitions are testable
// without mounting React (this package has no DOM test environment).
describe("nextGate", () => {
  const details: PairDetails = { label: "MacBook", cwd: "/work/repo", requestedAt: "iso" };

  it("demotes confirm -> needs-keys when the bridge reports no-keys", () => {
    const current: Gate = { kind: "confirm", ephPub: "eph1", ...details };
    expect(nextGate(current, "no-keys", details)).toEqual({ kind: "needs-keys", ephPub: "eph1" });
  });

  it("promotes needs-keys -> confirm when the bridge becomes ready, restoring the SAME ephPub and the hoisted details", () => {
    const current: Gate = { kind: "needs-keys", ephPub: "eph1" };
    expect(nextGate(current, "ready", details)).toEqual({
      kind: "confirm",
      ephPub: "eph1",
      ...details,
    });
  });

  it("promotes to confirm with nulls when details never resolved (e.g. fetchPairDetails failed)", () => {
    const current: Gate = { kind: "needs-keys", ephPub: "eph1" };
    expect(nextGate(current, "ready", null)).toEqual({
      kind: "confirm",
      ephPub: "eph1",
      label: null,
      cwd: null,
      requestedAt: null,
    });
  });

  it("leaves every other gate kind untouched by no-keys/ready transitions (guarded on the CURRENT kind)", () => {
    const checking: Gate = { kind: "checking" };
    expect(nextGate(checking, "no-keys", details)).toBe(checking);
    expect(nextGate(checking, "ready", details)).toBe(checking);

    const approving: Gate = { kind: "approving", ephPub: "eph1" };
    expect(nextGate(approving, "no-keys", details)).toBe(approving);
  });

  it("does not bounce confirm -> needs-keys -> confirm on a flickering loading/locked-out status", () => {
    const current: Gate = { kind: "confirm", ephPub: "eph1", ...details };
    expect(nextGate(current, "loading", details)).toBe(current);
    expect(nextGate(current, "locked-out", details)).toBe(current);
    expect(nextGate(current, "needs-migration", details)).toBe(current);
  });
});
