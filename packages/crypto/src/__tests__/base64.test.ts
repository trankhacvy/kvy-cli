import { describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64, encodeBase64Url } from "../base64.js";

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}

describe("base64", () => {
  it("round-trips arbitrary byte lengths (0..40, all padding cases)", () => {
    for (let len = 0; len <= 40; len++) {
      const bytes = randomBytes(len);
      const encoded = encodeBase64(bytes);
      expect(decodeBase64(encoded)).toEqual(bytes);
    }
  });

  it("round-trips base64url and strips padding", () => {
    const bytes = randomBytes(17);
    const url = encodeBase64Url(bytes);
    expect(url).not.toContain("=");
    expect(url).not.toContain("+");
    expect(url).not.toContain("/");
    expect(decodeBase64(url, "base64url")).toEqual(bytes);
  });

  it("matches known test vectors", () => {
    expect(encodeBase64(new TextEncoder().encode("hello world"))).toBe("aGVsbG8gd29ybGQ=");
    expect(decodeBase64("aGVsbG8gd29ybGQ=")).toEqual(new TextEncoder().encode("hello world"));
  });

  it("decodeBase64 never throws on garbage input", () => {
    expect(() => decodeBase64("not valid base64 !!! @@@")).not.toThrow();
    expect(() => decodeBase64("")).not.toThrow();
    expect(decodeBase64("")).toEqual(new Uint8Array(0));
  });
});
