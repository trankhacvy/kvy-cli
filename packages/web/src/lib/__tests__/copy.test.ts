import { describe, expect, it } from "vitest";
import { copy } from "../copy.js";

type CopyNode = string | ((arg: string) => string) | { [key: string]: CopyNode };

function strings(node: CopyNode): string[] {
  if (typeof node === "string") return [node];
  if (typeof node === "function") return [node("Sample")];
  return Object.values(node).flatMap(strings);
}

describe("web auth copy", () => {
  it("contains no internal jargon", () => {
    for (const value of strings(copy)) {
      expect(value).not.toMatch(
        /key material|masterSecret|keyEpoch|epoch|DEK|custody|bridge|ephPub/i,
      );
    }
  });

  it("destructive copy states its consequence", () => {
    expect(copy.reset.warning).toMatch(/erase|permanently/i);
  });

  it("the approve action names the check it depends on", () => {
    expect(copy.keys.sendCta).toMatch(/code/i);
  });

  it("never tells the user to run a command as the only recovery", () => {
    expect(copy.keys.needKeysBody).not.toMatch(/^run /i);
  });

  // auth-ux-overhaul-fix-plan.md Fix 9: the verification code is the security control, so
  // its copy is load-bearing — the requester side must say what a mismatch means, same as
  // the approver side (`copy.keys.codeMismatch`) already does.
  it("the requester's mismatch warning names the check it depends on", () => {
    expect(copy.keys.codeMismatchRequester).toMatch(/code/i);
  });
});
