/**
 * `pin.ts` (node) / `pin.web.ts` (browser) — PIN-wrapping round-trip, wrong-PIN
 * rejection, nonce uniqueness, and the cross-platform argon2id parity vector
 * `cross-impl.test.ts`'s header for why the web build runs for real here too.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { getRandomBytes } from "../encryption.js";
import { unwrapWithPin as unwrapNode, wrapWithPin as wrapNode } from "../pin.js";
import { pinReady, unwrapWithPin as unwrapWeb, wrapWithPin as wrapWeb } from "../pin.web.js";

beforeAll(async () => {
  await pinReady;
});

describe("pin.ts (node)", () => {
  it("round-trips a masterSecret", async () => {
    const secret = getRandomBytes(32);
    const wrapped = await wrapNode(secret, "123456");
    await expect(unwrapNode(wrapped, "123456")).resolves.toEqual(secret);
  });

  it("returns null for the wrong PIN", async () => {
    const secret = getRandomBytes(32);
    const wrapped = await wrapNode(secret, "123456");
    await expect(unwrapNode(wrapped, "000000")).resolves.toBeNull();
  });

  it("returns null for a corrupt blob", async () => {
    const secret = getRandomBytes(32);
    const wrapped = await wrapNode(secret, "123456");
    await expect(
      unwrapNode({ ...wrapped, ct: "not-base64-ciphertext" }, "123456"),
    ).resolves.toBeNull();
  });

  it("uses a fresh nonce (and salt) per wrap", async () => {
    const secret = getRandomBytes(32);
    const a = await wrapNode(secret, "123456");
    const b = await wrapNode(secret, "123456");
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.salt).not.toEqual(b.salt);
    expect(a.ct).not.toEqual(b.ct);
  });
}, 20_000);

describe("pin.web.ts (browser)", () => {
  it("round-trips a masterSecret", async () => {
    const secret = getRandomBytes(32);
    const wrapped = await wrapWeb(secret, "123456");
    await expect(unwrapWeb(wrapped, "123456")).resolves.toEqual(secret);
  });

  it("returns null for the wrong PIN", async () => {
    const secret = getRandomBytes(32);
    const wrapped = await wrapWeb(secret, "123456");
    await expect(unwrapWeb(wrapped, "000000")).resolves.toBeNull();
  });
}, 20_000);

describe("cross-platform argon2id parity", () => {
  it("node wraps -> web unwraps", async () => {
    const secret = getRandomBytes(32);
    const wrapped = await wrapNode(secret, "778899");
    await expect(unwrapWeb(wrapped, "778899")).resolves.toEqual(secret);
  });

  it("web wraps -> node unwraps", async () => {
    const secret = getRandomBytes(32);
    const wrapped = await wrapWeb(secret, "778899");
    await expect(unwrapNode(wrapped, "778899")).resolves.toEqual(secret);
  });
}, 20_000);
