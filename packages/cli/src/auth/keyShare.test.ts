import { encodeBase64, getRandomBytes, libsodiumDecryptWithSecretKey } from "@kvy/crypto";
import tweetnacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { verificationCode } from "../commands/keysApprove.js";
import { KEY_SHARE_PAYLOAD_VERSION, sealKeysForPeer } from "./keyShare.js";

describe("sealKeysForPeer", () => {
  it("produces a payload the requesting peer can open", () => {
    const masterSecret = getRandomBytes(32);
    const peer = tweetnacl.box.keyPair();

    const sealed = sealKeysForPeer(masterSecret, encodeBase64(peer.publicKey));
    expect(sealed).not.toBeNull();
    if (!sealed) throw new Error("unreachable");

    const opened = libsodiumDecryptWithSecretKey(Buffer.from(sealed, "base64"), peer.secretKey);
    expect(opened).not.toBeNull();
    if (!opened) throw new Error("unreachable");

    // The exact shape `web/src/crypto/worker-handler.ts` expects: version byte, then the
    // 32-byte master secret, and nothing else (no refresh token — the requesting device
    // already has its own session).
    expect(opened.length).toBe(1 + 32);
    expect(opened[0]).toBe(KEY_SHARE_PAYLOAD_VERSION);
    expect(opened.slice(1)).toEqual(masterSecret);
  });

  it("cannot be opened by a different key", () => {
    const masterSecret = getRandomBytes(32);
    const peer = tweetnacl.box.keyPair();
    const stranger = tweetnacl.box.keyPair();

    const sealed = sealKeysForPeer(masterSecret, encodeBase64(peer.publicKey));
    if (!sealed) throw new Error("unreachable");

    expect(
      libsodiumDecryptWithSecretKey(Buffer.from(sealed, "base64"), stranger.secretKey),
    ).toBeNull();
  });

  it("returns null for a malformed peer key rather than sealing to garbage", () => {
    expect(sealKeysForPeer(getRandomBytes(32), "too-short")).toBeNull();
  });
});

describe("verificationCode", () => {
  it("is deterministic and six digits", () => {
    const ephPub = encodeBase64(tweetnacl.box.keyPair().publicKey);
    const code = verificationCode(ephPub);
    expect(code).toMatch(/^\d{6}$/);
    expect(verificationCode(ephPub)).toBe(code);
  });

  it("differs between keys", () => {
    const a = verificationCode(encodeBase64(tweetnacl.box.keyPair().publicKey));
    const b = verificationCode(encodeBase64(tweetnacl.box.keyPair().publicKey));
    expect(a).not.toBe(b);
  });

  it("matches the web derivation byte-for-byte", async () => {
    // Both sides must show the SAME digits or the control is worthless. This mirrors
    // `web/src/lib/verification-code.ts`'s derivation exactly.
    const ephPub = encodeBase64(tweetnacl.box.keyPair().publicKey);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ephPub)),
    );
    const expected = String(
      ((((digest[0] ?? 0) << 24) |
        ((digest[1] ?? 0) << 16) |
        ((digest[2] ?? 0) << 8) |
        (digest[3] ?? 0)) >>>
        0) %
        1_000_000,
    ).padStart(6, "0");
    expect(verificationCode(ephPub)).toBe(expected);
  });
});
