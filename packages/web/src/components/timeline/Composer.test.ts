import { describe, expect, it } from "vitest";
import { isImageFile } from "./Composer";

describe("isImageFile (W4.2 — attach preview thumbnail gating)", () => {
  it("is true for any image/* MIME type", () => {
    expect(isImageFile({ type: "image/png" })).toBe(true);
    expect(isImageFile({ type: "image/jpeg" })).toBe(true);
    expect(isImageFile({ type: "image/webp" })).toBe(true);
  });

  it("is false for a non-image MIME type", () => {
    expect(isImageFile({ type: "application/pdf" })).toBe(false);
    expect(isImageFile({ type: "text/plain" })).toBe(false);
  });

  it("is false for an empty/unknown MIME type", () => {
    expect(isImageFile({ type: "" })).toBe(false);
  });
});
