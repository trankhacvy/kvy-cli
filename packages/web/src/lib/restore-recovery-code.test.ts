import { encodeRecoveryCode, getRandomBytes } from "@falcon/crypto/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CryptoBridgeClient } from "@/crypto";

const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }));

vi.mock("./api.js", () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));
vi.mock("./session.js", () => ({ setToken: vi.fn() }));
vi.mock("./pending-pair.js", () => ({ consumePendingPair: () => null }));

const { restoreRecoveryCode } = await import("./restore-recovery-code.js");

function fakeBridge(overrides: Partial<CryptoBridgeClient> = {}): CryptoBridgeClient {
  const notImplemented = () => {
    throw new Error("not implemented in this fake");
  };
  return {
    init: vi.fn(async () => undefined),
    setSessionKey: notImplemented,
    seal: notImplemented,
    open: notImplemented,
    sealBlob: notImplemented,
    openBlob: notImplemented,
    clear: vi.fn(async () => undefined),
    getIdentity: notImplemented,
    signInChallenge: async () => ({
      signPubKey: "sign-pub",
      contentPubKey: "content-pub",
      challenge: "chal",
      signature: "sig",
    }),
    exportRecoveryCode: notImplemented,
    sealForPeer: notImplemented,
    terminate: () => {},
    ...overrides,
  };
}

describe("restoreRecoveryCode", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("restores a genuine existing account: decodes, inits the bridge, and signs in", async () => {
    const secret = getRandomBytes(32);
    const code = encodeRecoveryCode(secret);
    signInMock.mockResolvedValue({
      success: true,
      token: "jwt-1",
      accountStatus: "found",
    });
    const bridge = fakeBridge();

    const outcome = await restoreRecoveryCode(bridge, code);

    expect(outcome).toEqual({ kind: "ok", nextUrl: "/" });
    expect(bridge.init).toHaveBeenCalledWith(secret);
    expect(bridge.clear).not.toHaveBeenCalled();
  });

  it("rejects a malformed/garbled code before any bridge or network interaction (no side effects)", async () => {
    const bridge = fakeBridge();

    const outcome = await restoreRecoveryCode(bridge, "not a real recovery code!!!");

    expect(outcome.kind).toBe("invalid-code");
    expect(bridge.init).not.toHaveBeenCalled();
    expect(bridge.clear).not.toHaveBeenCalled();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("rejects a well-formed-looking but never-issued code (its checksum won't match any 32-byte secret)", async () => {
    const bridge = fakeBridge();
    // 12 groups of well-formed base32 chars, but not derived from a real
    // masterSecret + its own checksum — the checksum check inside
    // decodeRecoveryCode itself must fail this before decodeRecoveryCode ever
    // returns bytes, so this never reaches init/signIn either.
    const madeUp = "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AA";

    const outcome = await restoreRecoveryCode(bridge, madeUp);

    expect(outcome.kind).toBe("invalid-code");
    expect(bridge.init).not.toHaveBeenCalled();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("the actual bug's negative case: a well-formed, checksum-valid code with no matching account is rejected and rolled back, not silently accepted", async () => {
    // This is the case the checksum alone cannot catch: a code that decodes
    // cleanly (real 32 random bytes + their own correct checksum) but was
    // never actually issued/registered server-side. `/v1/auth`'s upsert
    // would otherwise silently create a fresh, empty, disconnected account.
    const secret = getRandomBytes(32);
    const code = encodeRecoveryCode(secret);
    signInMock.mockResolvedValue({
      success: true,
      token: "jwt-new-empty-account",
      accountStatus: "created",
    });
    const bridge = fakeBridge();

    const outcome = await restoreRecoveryCode(bridge, code);

    expect(outcome).toEqual({
      kind: "no-account-found",
      message: "No account found for that recovery code.",
    });
    // The identity `bridge.init` persisted must be rolled back -- no usable
    // new account is left standing on this browser.
    expect(bridge.clear).toHaveBeenCalledTimes(1);
  });

  it("rolls back the persisted identity and reports a generic failure when sign-in itself throws", async () => {
    const secret = getRandomBytes(32);
    const code = encodeRecoveryCode(secret);
    signInMock.mockRejectedValue(new Error("network blip"));
    const bridge = fakeBridge();

    const outcome = await restoreRecoveryCode(bridge, code);

    expect(outcome).toEqual({
      kind: "sign-in-failed",
      message: "Restore failed. Please retry.",
    });
    expect(bridge.clear).toHaveBeenCalledTimes(1);
  });

  it("swallows a rollback failure and still reports the original outcome", async () => {
    const secret = getRandomBytes(32);
    const code = encodeRecoveryCode(secret);
    signInMock.mockResolvedValue({
      success: true,
      token: "jwt-new-empty-account",
      accountStatus: "created",
    });
    const bridge = fakeBridge({
      clear: vi.fn(async () => {
        throw new Error("IndexedDB unavailable");
      }),
    });

    const outcome = await restoreRecoveryCode(bridge, code);

    expect(outcome.kind).toBe("no-account-found");
  });
});
