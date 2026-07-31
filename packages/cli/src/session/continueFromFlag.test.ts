import { describe, expect, it } from "vitest";
import { extractContinueFromFlag } from "./continueFromFlag.js";

describe("extractContinueFromFlag", () => {
  it("returns null when no --continue-from flag is present", () => {
    expect(extractContinueFromFlag([])).toBeNull();
    expect(extractContinueFromFlag(["--verbose", "-p"])).toBeNull();
  });

  it("reads a space-separated --continue-from <value>", () => {
    expect(extractContinueFromFlag(["--continue-from", "sess-123"])).toBe("sess-123");
  });

  it("reads a --continue-from=value form", () => {
    expect(extractContinueFromFlag(["--continue-from=sess-456"])).toBe("sess-456");
  });

  it("ignores a --continue-from flag with no following value (next token is another flag)", () => {
    expect(extractContinueFromFlag(["--continue-from", "--verbose"])).toBeNull();
  });

  it("ignores a --continue-from flag that's the last token with nothing after it", () => {
    expect(extractContinueFromFlag(["--verbose", "--continue-from"])).toBeNull();
  });

  it("last occurrence wins when --continue-from appears more than once", () => {
    expect(extractContinueFromFlag(["--continue-from", "a", "--continue-from", "b"])).toBe("b");
  });

  it("finds --continue-from among other passthrough flags in any position", () => {
    expect(extractContinueFromFlag(["-p", "--continue-from", "sess-789", "--verbose"])).toBe(
      "sess-789",
    );
  });
});
