import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CryptoBridgeClient } from "@/crypto";
import { createMemoryStorage } from "./__tests__/test-storage.js";

const {
  passwordRegisterMock,
  passwordLoginMock,
  keysChallengeMock,
  keysBindMock,
  markCryptoBridgeUnlockedMock,
} = vi.hoisted(() => ({
  passwordRegisterMock: vi.fn(),
  passwordLoginMock: vi.fn(),
  keysChallengeMock: vi.fn(),
  keysBindMock: vi.fn(),
  markCryptoBridgeUnlockedMock: vi.fn(),
}));

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    passwordRegister: passwordRegisterMock,
    passwordLogin: passwordLoginMock,
    keysChallenge: keysChallengeMock,
    keysBind: keysBindMock,
  };
});

vi.mock("./use-crypto-bridge.js", () => ({
  markCryptoBridgeUnlocked: markCryptoBridgeUnlockedMock,
}));

const { ApiError } = await import("./api.js");
const { completePasswordSignIn, completePasswordSignUp, rotateKeyEpoch, rotateKeyEpochOAuth } =
  await import("./complete-password-sign-in.js");

/** A valid-shaped JWT (`{sub}` payload) — the sign-in flows only ever decode `sub`
 * client-side, never verify a signature (the server is the actual authority). */
function fakeAccessToken(sub: string): string {
  const header = btoa(JSON.stringify({ alg: "none" }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function fakeBridge(overrides: Partial<CryptoBridgeClient> = {}): CryptoBridgeClient {
  const notImplemented = () => {
    throw new Error("not implemented in this fake");
  };
  let identity: { signPubKey: string; contentPubKey: string } | null = null;
  return {
    init: async () => {
      identity = { signPubKey: "sign-pub", contentPubKey: "content-pub" };
    },
    unlock: notImplemented,
    setSessionKey: notImplemented,
    seal: notImplemented,
    open: notImplemented,
    sealBlob: notImplemented,
    openBlob: notImplemented,
    clear: notImplemented,
    getIdentity: async () => identity,
    sealForPeer: notImplemented,
    bindKeysProof: async () => ({
      signPubKey: "sign-pub",
      contentPubKey: "content-pub",
      signature: "sig",
    }),
    setRefreshToken: async () => undefined,
    refreshSession: notImplemented,
    terminate: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  passwordRegisterMock.mockReset();
  passwordLoginMock.mockReset();
  keysChallengeMock.mockReset().mockResolvedValue({ nonce: "n1" });
  keysBindMock.mockReset().mockResolvedValue({ success: true, keyEpoch: 1 });
  markCryptoBridgeUnlockedMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("completePasswordSignUp", () => {
  it("registers, PIN-wraps a fresh identity, and binds it (first bind)", async () => {
    const token = fakeAccessToken("acct_1");
    passwordRegisterMock.mockResolvedValue({ success: true, token, refreshToken: "rt1" });
    const bridge = fakeBridge();

    const outcome = await completePasswordSignUp(bridge, "a@b.com", "password123", "123456");

    expect(outcome).toEqual({ nextUrl: "/" });
    expect(keysBindMock).toHaveBeenCalledWith(
      token,
      expect.objectContaining({ signPubKey: "sign-pub", contentPubKey: "content-pub" }),
    );
    expect(markCryptoBridgeUnlockedMock).toHaveBeenCalled();
  });

  it("reuses an existing identity instead of generating a second one", async () => {
    const token = fakeAccessToken("acct_1");
    passwordRegisterMock.mockResolvedValue({ success: true, token, refreshToken: "rt1" });
    const initSpy = vi.fn();
    const bridge = fakeBridge({
      init: initSpy,
      getIdentity: async () => ({ signPubKey: "existing", contentPubKey: "existing-content" }),
    });

    await completePasswordSignUp(bridge, "a@b.com", "password123", "123456");

    expect(initSpy).not.toHaveBeenCalled();
  });
});

describe("completePasswordSignIn", () => {
  it("logs in and stores the session, without touching key material", async () => {
    passwordLoginMock.mockResolvedValue({ success: true, token: "t1", refreshToken: "rt1" });

    const outcome = await completePasswordSignIn("a@b.com", "password123");

    expect(outcome).toEqual({ nextUrl: "/", refreshToken: "rt1" });
  });
});

describe("rotateKeyEpoch", () => {
  it("generates fresh key material and force-rotates on a correct step-up password", async () => {
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpoch(bridge, token, "rt1", "correct-password", "654321");

    expect(outcome).toEqual({ kind: "ok", nextUrl: "/" });
    expect(keysBindMock).toHaveBeenCalledWith(
      token,
      expect.objectContaining({
        rotate: true,
        stepUpProof: { kind: "password", password: "correct-password" },
      }),
    );
    expect(markCryptoBridgeUnlockedMock).toHaveBeenCalled();
  });

  it("reports wrong-password on a 401 from keys/bind, without crashing", async () => {
    keysBindMock.mockRejectedValue(new ApiError("Step-up required to rotate keys", 401));
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpoch(bridge, token, "rt1", "wrong-password", "654321");

    expect(outcome.kind).toBe("wrong-password");
  });

  it("reports other-devices-online on a 409 from keys/bind (the interlock)", async () => {
    keysBindMock.mockRejectedValue(
      new ApiError("Other devices are online — pair from one instead of rotating", 409),
    );
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpoch(bridge, token, "rt1", "correct-password", "654321");

    expect(outcome.kind).toBe("other-devices-online");
  });
});

describe("rotateKeyEpochOAuth", () => {
  // `consumePendingPair()` (used to resolve `nextUrl`) reads `window.sessionStorage`
  // directly — this package's vitest config runs under `environment: "node"` (no
  // `window` by default), so these tests need the same stand-in `lib/__tests__/
  // pending-pair.test.ts` uses.
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { sessionStorage: createMemoryStorage() };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("generates fresh key material and force-rotates with an oauth step-up proof", async () => {
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpochOAuth(bridge, token, "rt1", "654321", {
      provider: "google",
      oauthProof: "id-token-1",
    });

    expect(outcome).toEqual({ kind: "ok", nextUrl: "/" });
    expect(keysBindMock).toHaveBeenCalledWith(
      token,
      expect.objectContaining({
        rotate: true,
        stepUpProof: { kind: "oauth", provider: "google", oauthProof: "id-token-1" },
      }),
    );
    expect(markCryptoBridgeUnlockedMock).toHaveBeenCalled();
  });

  it("resolves nextUrl from a pending /pair stash, same as completeOAuthSignIn", async () => {
    const { stashPendingPair } = await import("./pending-pair.js");
    stashPendingPair("eph-pub-base64==");
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpochOAuth(bridge, token, "rt1", "654321", {
      provider: "github",
      oauthProof: "gh-token-1",
    });

    expect(outcome).toEqual({ kind: "ok", nextUrl: "/pair/#eph-pub-base64==" });
  });

  it("reports identity-mismatch on a 401 from keys/bind (wrong account at the provider)", async () => {
    keysBindMock.mockRejectedValue(new ApiError("Step-up required to rotate keys", 401));
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpochOAuth(bridge, token, "rt1", "654321", {
      provider: "google",
      oauthProof: "id-token-1",
    });

    expect(outcome.kind).toBe("identity-mismatch");
  });

  it("reports other-devices-online on a 409 from keys/bind (the interlock)", async () => {
    keysBindMock.mockRejectedValue(
      new ApiError("Other devices are online — pair from one instead of rotating", 409),
    );
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpochOAuth(bridge, token, "rt1", "654321", {
      provider: "google",
      oauthProof: "id-token-1",
    });

    expect(outcome.kind).toBe("other-devices-online");
  });
});
