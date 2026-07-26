import { describe, expect, it } from "vitest";
import { derivePhaseFromReturn } from "../reset-keys-phase.js";

describe("derivePhaseFromReturn", () => {
  it("with no in-memory return payload, stays on the confirm-identity phase", () => {
    expect(derivePhaseFromReturn(null)).toEqual({ kind: "confirm-identity" });
  });

  // docs/auth-ux-hardening-plan.md item 4/8: `/reset-keys/` is reachable from BOTH a
  // `no-identity` visitor (device wiped / genuinely new) and a `needs-unlock` one (forgotten
  // PIN) — neither is checked here at all, only whether the OAuth callback left a return
  // payload — so completing the provider round trip must land BOTH kinds of entrant on the
  // PIN-setup ("returned") phase identically.
  it("with a return payload, reaches the PIN-setup phase regardless of the entrant's prior bridge state", () => {
    const ret = { provider: "google" as const, oauthProof: "id-token-1", refreshToken: "rt1" };
    expect(derivePhaseFromReturn(ret)).toEqual({ kind: "returned", method: "oauth", ...ret });
  });

  it("carries the github provider through the same way", () => {
    const ret = { provider: "github" as const, oauthProof: "gh-token-1", refreshToken: "rt2" };
    expect(derivePhaseFromReturn(ret)).toEqual({ kind: "returned", method: "oauth", ...ret });
  });
});
