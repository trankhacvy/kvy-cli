import { describe, expect, it } from "vitest";
import { decodeBase64 } from "../base64.js";
import { open, seal } from "../box.js";
import { getRandomBytes } from "../encryption.js";

describe("EncryptedBox seal/open", () => {
  const dek = getRandomBytes(32);

  it("round-trips arbitrary JSON-serializable data", () => {
    const payload = { t: "text", md: "hello **world**", nested: { a: [1, 2, 3] } };
    const box = seal(payload, dek);
    expect(box).toEqual({ t: "enc", v: 1, c: expect.any(String) });
    expect(open(box, dek)).toEqual(payload);
  });

  it("open() returns null (never throws) on wrong key", () => {
    const box = seal({ secret: 42 }, dek);
    const wrongDek = getRandomBytes(32);
    expect(() => open(box, wrongDek)).not.toThrow();
    expect(open(box, wrongDek)).toBeNull();
  });

  it("open() returns null (never throws) on a corrupted box — one bad record cannot poison a batch", () => {
    const box = seal({ secret: 42 }, dek);
    const bytes = decodeBase64(box.c);
    // biome-ignore lint/style/noNonNullAssertion: index is within bounds (length > 0 guaranteed by decodeBase64)
    bytes[bytes.length - 1]! ^= 0xff;
    const corrupted = { ...box, c: Buffer.from(bytes).toString("base64") };
    expect(() => open(corrupted, dek)).not.toThrow();
    expect(open(corrupted, dek)).toBeNull();
  });

  it("open() returns null on a garbage `c` field", () => {
    const box = { t: "enc" as const, v: 1 as const, c: "not-valid-base64-ciphertext" };
    expect(() => open(box, dek)).not.toThrow();
    expect(open(box, dek)).toBeNull();
  });
});
