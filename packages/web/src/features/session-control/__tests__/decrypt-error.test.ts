import { describe, expect, it } from "vitest";
import { formatDecryptError } from "../decrypt-error.js";

describe("formatDecryptError", () => {
  it("uses a real Error's message", () => {
    expect(formatDecryptError(new Error("worker crashed mid-batch"))).toBe(
      "worker crashed mid-batch",
    );
  });

  it("falls back to a generic message for a non-Error throw", () => {
    expect(formatDecryptError("some string throw")).toBe(
      "Failed to decrypt this session's messages.",
    );
  });

  it("falls back to a generic message for an Error with an empty message", () => {
    expect(formatDecryptError(new Error(""))).toBe("Failed to decrypt this session's messages.");
  });

  it("falls back to a generic message for undefined/null", () => {
    expect(formatDecryptError(undefined)).toBe("Failed to decrypt this session's messages.");
    expect(formatDecryptError(null)).toBe("Failed to decrypt this session's messages.");
  });
});
