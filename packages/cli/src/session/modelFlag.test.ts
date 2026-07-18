import { describe, expect, it } from "vitest";
import { extractModelFlag } from "./modelFlag.js";

describe("extractModelFlag", () => {
  it("returns undefined when no --model flag is present", () => {
    expect(extractModelFlag([])).toBeUndefined();
    expect(extractModelFlag(["--verbose", "-p"])).toBeUndefined();
  });

  it("reads a space-separated --model <value>", () => {
    expect(extractModelFlag(["--model", "sonnet"])).toBe("sonnet");
  });

  it("reads an --model=value form", () => {
    expect(extractModelFlag(["--model=opus"])).toBe("opus");
  });

  it("ignores a --model flag with no following value (next token is another flag)", () => {
    expect(extractModelFlag(["--model", "--verbose"])).toBeUndefined();
  });

  it("ignores a --model flag that's the last token with nothing after it", () => {
    expect(extractModelFlag(["--verbose", "--model"])).toBeUndefined();
  });

  it("last occurrence wins when --model appears more than once", () => {
    expect(extractModelFlag(["--model", "sonnet", "--model", "opus"])).toBe("opus");
    expect(extractModelFlag(["--model=sonnet", "--model=opus"])).toBe("opus");
    expect(extractModelFlag(["--model", "sonnet", "--model=opus"])).toBe("opus");
  });

  it("finds --model among other passthrough flags in any position", () => {
    expect(extractModelFlag(["-p", "--model", "haiku", "--verbose"])).toBe("haiku");
  });
});
