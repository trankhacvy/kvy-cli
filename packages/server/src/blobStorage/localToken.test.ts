import { describe, expect, it } from "vitest";
import { signBlobToken, verifyBlobToken } from "./localToken.js";

const SECRET = "test-secret-at-least-32-chars-long!!";

describe("localToken", () => {
  it("a freshly signed token verifies for the same op/key", () => {
    const { token, exp } = signBlobToken(SECRET, "upload", "blob-1", 300);
    expect(verifyBlobToken(SECRET, "upload", "blob-1", exp, token)).toBe(true);
  });

  it("rejects a token for a different op", () => {
    const { token, exp } = signBlobToken(SECRET, "upload", "blob-1", 300);
    expect(verifyBlobToken(SECRET, "download", "blob-1", exp, token)).toBe(false);
  });

  it("rejects a token for a different key", () => {
    const { token, exp } = signBlobToken(SECRET, "upload", "blob-1", 300);
    expect(verifyBlobToken(SECRET, "upload", "blob-2", exp, token)).toBe(false);
  });

  it("rejects a token signed under a different secret", () => {
    const { token, exp } = signBlobToken(SECRET, "upload", "blob-1", 300);
    expect(verifyBlobToken("a-completely-different-secret!!", "upload", "blob-1", exp, token)).toBe(
      false,
    );
  });

  it("rejects an expired token", () => {
    const { token } = signBlobToken(SECRET, "upload", "blob-1", 300);
    const pastExp = Date.now() - 1000;
    expect(verifyBlobToken(SECRET, "upload", "blob-1", pastExp, token)).toBe(false);
  });

  it("rejects a tampered token of the same length", () => {
    const { token, exp } = signBlobToken(SECRET, "upload", "blob-1", 300);
    const tampered = `${token.slice(0, -1)}${token.at(-1) === "0" ? "1" : "0"}`;
    expect(verifyBlobToken(SECRET, "upload", "blob-1", exp, tampered)).toBe(false);
  });

  it("rejects a malformed (non-hex-length) token without throwing", () => {
    expect(verifyBlobToken(SECRET, "upload", "blob-1", Date.now() + 1000, "not-a-real-token")).toBe(
      false,
    );
  });

  it("rejects a non-finite exp", () => {
    expect(verifyBlobToken(SECRET, "upload", "blob-1", Number.NaN, "whatever")).toBe(false);
  });
});
