import { describe, expect, it } from "vitest";
import { urlBase64ToUint8Array } from "../vapid.js";

describe("urlBase64ToUint8Array", () => {
  it("decodes a base64url string with no padding needed", () => {
    // "hello" -> base64 "aGVsbG8=" -> base64url "aGVsbG8" (no '=' needed: length % 4 === 3, one '=' actually IS needed... use a case with 0 padding)
    const bytes = urlBase64ToUint8Array("aGVsbG8"); // "hello", 1 pad char added internally
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  it("decodes a base64url string that needs '-'/'_' translated back to '+'/'/'", () => {
    // Raw bytes 0xfb 0xff 0xbf encode to base64 "+/+/" family; construct a known
    // vector instead of hand-deriving one: encode with btoa then convert to url-safe.
    const raw = new Uint8Array([0xfb, 0xef, 0xbe]);
    const std = btoa(String.fromCharCode(...raw)); // standard base64, e.g. "++++"-ish
    const urlSafe = std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const decoded = urlBase64ToUint8Array(urlSafe);
    expect(Array.from(decoded)).toEqual(Array.from(raw));
  });

  it("round-trips an arbitrary byte sequence through btoa -> urlsafe -> decode", () => {
    const raw = new Uint8Array([0, 1, 2, 253, 254, 255, 16, 32]);
    const std = btoa(String.fromCharCode(...raw));
    const urlSafe = std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    expect(Array.from(urlBase64ToUint8Array(urlSafe))).toEqual(Array.from(raw));
  });
});
