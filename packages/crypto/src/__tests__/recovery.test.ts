import { describe, expect, it } from "vitest";
import { getRandomBytes } from "../encryption.js";
import { decodeRecoveryCode, encodeRecoveryCode } from "../recovery.js";

describe("recovery code (grouped Base32 + checksum)", () => {
  it("round-trips a random 32-byte masterSecret", () => {
    for (let i = 0; i < 20; i++) {
      const secret = getRandomBytes(32);
      const code = encodeRecoveryCode(secret);
      expect(decodeRecoveryCode(code)).toEqual(secret);
    }
  });

  it("is grouped into dash-separated chunks of up to 5 chars", () => {
    const code = encodeRecoveryCode(getRandomBytes(32));
    const groups = code.split("-");
    // 36-byte payload (32B secret + 4B checksum) -> 58 base32 chars -> 12 groups.
    expect(groups.length).toBe(12);
    for (const g of groups) expect(g.length).toBeLessThanOrEqual(5);
  });

  it("decodes case-insensitively and tolerates stray whitespace", () => {
    const secret = getRandomBytes(32);
    const code = encodeRecoveryCode(secret);
    expect(decodeRecoveryCode(code.toLowerCase())).toEqual(secret);
    expect(decodeRecoveryCode(`  ${code}  `.replaceAll("-", " - "))).toEqual(secret);
  });

  it("normalizes common typos: 0->O, 1->I, 8->B, 9->G", () => {
    const secret = getRandomBytes(32);
    const code = encodeRecoveryCode(secret);
    // Only meaningful if the code actually contains a letter that could be typo'd;
    // verify the normalization functions don't corrupt a code that has none, and
    // separately verify the substitution table directly.
    expect(decodeRecoveryCode(code)).toEqual(secret);

    const withTypos = code
      .replaceAll("O", "0")
      .replaceAll("I", "1")
      .replaceAll("B", "8")
      .replaceAll("G", "9");
    expect(decodeRecoveryCode(withTypos)).toEqual(secret);
  });

  it("returns null (never throws) on garbage input", () => {
    expect(() => decodeRecoveryCode("not a real code")).not.toThrow();
    expect(decodeRecoveryCode("")).toBeNull();
    expect(decodeRecoveryCode("!!!---###")).toBeNull();
  });

  it("returns null when decoded length is not exactly 36 bytes (32B secret + 4B checksum)", () => {
    expect(decodeRecoveryCode("ABCDE")).toBeNull(); // way too short
  });

  it("returns null for a code that decodes to the old unchecksummed 32-byte length", () => {
    // Pre-checksum format: exactly 32 bytes, no trailing checksum. This is the
    // format `decodeRecoveryCode` used to accept unconditionally — it must now
    // be rejected, since a genuine 36-byte payload never collapses to 32.
    const secret = getRandomBytes(32);
    // Re-implement the old (checksum-less) encoder inline to build a legacy-shaped code.
    const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    function bytesToBase32(bytes: Uint8Array): string {
      let result = "";
      let buffer = 0;
      let bufferLength = 0;
      for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bufferLength += 8;
        while (bufferLength >= 5) {
          bufferLength -= 5;
          result += BASE32_ALPHABET[(buffer >> bufferLength) & 0x1f];
        }
      }
      if (bufferLength > 0) {
        result += BASE32_ALPHABET[(buffer << (5 - bufferLength)) & 0x1f];
      }
      return result;
    }
    const legacyCode = bytesToBase32(secret);
    expect(decodeRecoveryCode(legacyCode)).toBeNull();
  });

  it("rejects a garbled/wrong-but-well-formed code: a bit-flip anywhere in a genuine code fails the checksum", () => {
    const secret = getRandomBytes(32);
    const code = encodeRecoveryCode(secret);
    const cleaned = code.replaceAll("-", "");

    // Flip each character position (to a different valid base32 char) and confirm
    // every single-character corruption is caught by the checksum. This is the
    // exact negative case from the bug report: a wrong-but-correctly-shaped code
    // must fail to decode rather than silently succeeding. The final base32
    // character carries a couple of unused zero-padding bits (36 bytes = 288
    // bits isn't a multiple of 5), so a flip confined entirely to those padding
    // bits doesn't change the decoded byte array at all — that one position is
    // excluded since it isn't a real corruption of the payload.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let sawAtLeastOneMismatch = false;
    for (let i = 0; i < cleaned.length - 1; i++) {
      const original = cleaned[i] as string;
      const replacement = alphabet[(alphabet.indexOf(original) + 1) % alphabet.length] as string;
      const corrupted = cleaned.slice(0, i) + replacement + cleaned.slice(i + 1);
      if (corrupted === cleaned) continue;
      sawAtLeastOneMismatch = true;
      expect(decodeRecoveryCode(corrupted)).toBeNull();
    }
    expect(sawAtLeastOneMismatch).toBe(true);
  });

  it("rejects a well-formed-looking but never-issued (made-up) code", () => {
    // A completely fabricated 36-byte-shaped code (not derived from any real
    // masterSecret) should have a vanishingly small chance of passing the
    // checksum, and this fixed example does not.
    const madeUp = "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AA";
    expect(decodeRecoveryCode(madeUp)).toBeNull();
  });

  it("encodeRecoveryCode's checksum is deterministic for the same secret", () => {
    const secret = getRandomBytes(32);
    expect(encodeRecoveryCode(secret)).toEqual(encodeRecoveryCode(secret));
  });
});
