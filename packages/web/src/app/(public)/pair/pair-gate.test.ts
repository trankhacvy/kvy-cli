import { describe, expect, it } from "vitest";
import { resolvePairGate } from "./pair-gate";

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
        return true;
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
        silentRefresh: async () => true,
      },
    );
    expect(gate).toBe("confirm");
  });

  it("only bounces to signin when identity exists but silentRefresh also fails", async () => {
    const gate = await resolvePairGate(
      { accountId: "acct_1" },
      {
        isSignedIn: () => false,
        silentRefresh: async () => false,
      },
    );
    expect(gate).toBe("signin");
  });
});
