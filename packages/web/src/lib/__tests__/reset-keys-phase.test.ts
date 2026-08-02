import { describe, expect, it } from "vitest";
import { derivePhaseFromReturn } from "../reset-keys-phase.js";

describe("derivePhaseFromReturn", () => {
  it("with no in-memory return payload, stays on the confirm-identity phase", () => {
    expect(derivePhaseFromReturn(null)).toEqual({ kind: "confirm-identity" });
  });

  // `/reset-keys/` is reachable from both a `no-identity` visitor and a `needs-unlock` one;
  // only whether the OAuth callback left a return payload matters here, so both entrant
  // types must land on the PIN-setup phase identically.
  it("with a return payload, reaches the PIN-setup phase regardless of the entrant's prior bridge state", () => {
    const ret = { provider: "google" as const, oauthProof: "id-token-1", refreshToken: "rt1" };
    expect(derivePhaseFromReturn(ret)).toEqual({ kind: "returned", method: "oauth", ...ret });
  });

  it("carries the github provider through the same way", () => {
    const ret = { provider: "github" as const, oauthProof: "gh-token-1", refreshToken: "rt2" };
    expect(derivePhaseFromReturn(ret)).toEqual({ kind: "returned", method: "oauth", ...ret });
  });
});
