/**
 * Round-trip proof for Flow 4's "pair with a teammate" sharing primitive
 * (kvy-flows plan, Flow 4 root-cause point 3 — `docs/plan-flows-3-4-5.md`).
 *
 * No new crypto: this validates that `wrapDek`/`unwrapDek` (`../dek.js`) —
 * already used for the owner's own DEK — also works, unmodified, as a
 * scoped grant to a *different* identity's key tree. The owner re-wraps a
 * session's DEK to the teammate's `content.publicKey`; the teammate (and
 * only the teammate) can unwrap it with their own `content.secretKey`. Owner
 * and teammate here are two independently-derived `deriveKeyTree` outputs
 * (i.e. two different `masterSecret`s), not two views of the same key —
 * this is the "genuinely different person," not a second device on the same
 * account.
 */
import { describe, expect, it } from "vitest";
import { unwrapDek, wrapDek } from "../dek.js";
import { getRandomBytes } from "../encryption.js";
import { deriveKeyTree } from "../keys.js";

describe("session-sharing DEK round-trip (Flow 4)", () => {
  it("wraps a session DEK to a teammate's content key and only the teammate can unwrap it", () => {
    const owner = deriveKeyTree(getRandomBytes(32));
    const teammate = deriveKeyTree(getRandomBytes(32));
    const sessionDek = getRandomBytes(32);

    // Owner re-wraps the session DEK to the teammate's content public key —
    // the grant step FL4.3's speculative `session_shares.wrappedDek` would
    // store.
    const wrappedForTeammate = wrapDek(sessionDek, teammate.content.publicKey);

    // The teammate recovers the exact original DEK with their own content
    // secret key.
    expect(unwrapDek(wrappedForTeammate, teammate.content.secretKey)).toEqual(sessionDek);

    // The same wrapped value is opaque to the owner's own content secret
    // key — the owner's key tree is genuinely independent of the
    // teammate's, so re-wrapping to the teammate does not also leave it
    // openable by the owner's key.
    expect(unwrapDek(wrappedForTeammate, owner.content.secretKey)).toBeNull();
  });
});
