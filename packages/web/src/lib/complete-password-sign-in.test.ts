import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CryptoBridgeClient } from "@/crypto";
import { createMemoryStorage } from "./__tests__/test-storage.js";

const {
  passwordRegisterMock,
  passwordLoginMock,
  keysChallengeMock,
  keysBindMock,
  revokeOtherSessionsMock,
} = vi.hoisted(() => ({
  passwordRegisterMock: vi.fn(),
  passwordLoginMock: vi.fn(),
  keysChallengeMock: vi.fn(),
  keysBindMock: vi.fn(),
  revokeOtherSessionsMock: vi.fn(),
}));

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    passwordRegister: passwordRegisterMock,
    passwordLogin: passwordLoginMock,
    keysChallenge: keysChallengeMock,
    keysBind: keysBindMock,
    revokeOtherSessions: revokeOtherSessionsMock,
  };
});

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
    setSessionKey: notImplemented,
    createDek: notImplemented,
    seal: notImplemented,
    open: notImplemented,
    sealBlob: notImplemented,
    openBlob: notImplemented,
    clear: notImplemented,
    describeStorage: notImplemented,
    ensureLoaded: notImplemented,
    migrateFromPin: notImplemented,
    beginKeyRequest: notImplemented,
    acceptKeyResponse: notImplemented,
    sealKeysForPeer: notImplemented,
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
  revokeOtherSessionsMock.mockReset().mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("completePasswordSignUp", () => {
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

  it("registers, PIN-wraps a fresh identity, and binds it (first bind)", async () => {
    const token = fakeAccessToken("acct_1");
    passwordRegisterMock.mockResolvedValue({ success: true, token, refreshToken: "rt1" });
    const bridge = fakeBridge();

    const outcome = await completePasswordSignUp(bridge, "a@b.com", "password123", {
      mode: "device",
    });

    expect(outcome).toEqual({ kind: "ok", nextUrl: "/dashboard/" });
    expect(keysBindMock).toHaveBeenCalledWith(
      token,
      expect.objectContaining({ signPubKey: "sign-pub", contentPubKey: "content-pub" }),
    );
  });

  it("resolves nextUrl from a pending /pair stash, same as completeOAuthSignIn", async () => {
    const { stashPendingPair } = await import("./pending-pair.js");
    stashPendingPair("eph-pub-base64==");
    const token = fakeAccessToken("acct_1");
    passwordRegisterMock.mockResolvedValue({ success: true, token, refreshToken: "rt1" });
    const bridge = fakeBridge();

    const outcome = await completePasswordSignUp(bridge, "a@b.com", "password123", {
      mode: "device",
    });

    expect(outcome).toEqual({ kind: "ok", nextUrl: "/pair/#eph-pub-base64==" });
  });

  // A new account can never legitimately already have key material on this browser.
  // A browser holding a DIFFERENT account's leftover keys must provision fresh,
  // account-scoped ones rather than silently reusing the other account's public key.
  it("always provisions fresh key material for a new account, even when this browser already holds a DIFFERENT account's identity", async () => {
    const token = fakeAccessToken("acct_1");
    passwordRegisterMock.mockResolvedValue({ success: true, token, refreshToken: "rt1" });
    const initSpy = vi.fn(async () => {});
    const bridge = fakeBridge({
      init: initSpy,
      // A foreign identity already sitting in this browser's key store.
      getIdentity: async () => ({ signPubKey: "foreign-sign", contentPubKey: "foreign-content" }),
    });

    await completePasswordSignUp(bridge, "a@b.com", "password123", { mode: "device" });

    expect(initSpy).toHaveBeenCalledOnce();
    expect(initSpy).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "rt1",
      "acct_1",
      expect.objectContaining({ mode: "device" }),
    );
    expect(keysBindMock).toHaveBeenCalledWith(
      token,
      expect.objectContaining({ signPubKey: "sign-pub", contentPubKey: "content-pub" }),
    );
  });

  it("reports existing-account (not a crash) on the server's no-enumeration blank-token response", async () => {
    passwordRegisterMock.mockResolvedValue({ success: true, token: "", refreshToken: "" });
    const bridge = fakeBridge();

    const outcome = await completePasswordSignUp(bridge, "a@b.com", "password123", {
      mode: "device",
    });

    expect(outcome).toEqual({ kind: "existing-account" });
    expect(keysBindMock).not.toHaveBeenCalled();
  });
});

describe("completePasswordSignIn", () => {
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

  it("logs in and stores the session, without touching key material", async () => {
    passwordLoginMock.mockResolvedValue({ success: true, token: "t1", refreshToken: "rt1" });

    const outcome = await completePasswordSignIn("a@b.com", "password123");

    expect(outcome).toEqual({ nextUrl: "/dashboard/", refreshToken: "rt1" });
  });

  it("resolves nextUrl from a pending /pair stash, same as completeOAuthSignIn", async () => {
    const { stashPendingPair } = await import("./pending-pair.js");
    stashPendingPair("eph-pub-base64==");
    passwordLoginMock.mockResolvedValue({ success: true, token: "t1", refreshToken: "rt1" });

    const outcome = await completePasswordSignIn("a@b.com", "password123");

    expect(outcome).toEqual({ nextUrl: "/pair/#eph-pub-base64==", refreshToken: "rt1" });
  });
});

describe("rotateKeyEpoch", () => {
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

  it("generates fresh key material and force-rotates on a correct step-up password", async () => {
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpoch(bridge, token, "rt1", "correct-password", {
      mode: "device",
    });

    expect(outcome).toEqual({ kind: "ok", nextUrl: "/dashboard/" });
    expect(keysBindMock).toHaveBeenCalledWith(
      token,
      expect.objectContaining({
        rotate: true,
        stepUpProof: { kind: "password", password: "correct-password" },
      }),
    );
  });

  it("resolves nextUrl from a pending /pair stash, same as completeOAuthSignIn", async () => {
    const { stashPendingPair } = await import("./pending-pair.js");
    stashPendingPair("eph-pub-base64==");
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpoch(bridge, token, "rt1", "correct-password", {
      mode: "device",
    });

    expect(outcome).toEqual({ kind: "ok", nextUrl: "/pair/#eph-pub-base64==" });
  });

  it("reports wrong-password on a 401 from keys/bind, without crashing", async () => {
    keysBindMock.mockRejectedValue(new ApiError("Step-up required to rotate keys", 401));
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpoch(bridge, token, "rt1", "wrong-password", {
      mode: "device",
    });

    expect(outcome.kind).toBe("wrong-password");
  });

  it("auto-revokes other sessions on 409 and retries bind", async () => {
    keysBindMock
      .mockRejectedValueOnce(
        new ApiError("Other devices are online — pair from one instead of rotating", 409),
      )
      .mockResolvedValueOnce({ success: true, keyEpoch: 2 });
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpoch(bridge, token, "rt1", "correct-password", {
      mode: "device",
    });

    expect(revokeOtherSessionsMock).toHaveBeenCalledOnce();
    expect(keysBindMock).toHaveBeenCalledTimes(2);
    expect(outcome.kind).toBe("ok");
  });

  it("returns an error if revokeOtherSessions itself fails on 409", async () => {
    keysBindMock.mockRejectedValue(
      new ApiError("Other devices are online — pair from one instead of rotating", 409),
    );
    revokeOtherSessionsMock.mockRejectedValue(new ApiError("Server error", 500));
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpoch(bridge, token, "rt1", "correct-password", {
      mode: "device",
    });

    expect(outcome.kind).toBe("error");
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

    const outcome = await rotateKeyEpochOAuth(
      bridge,
      token,
      "rt1",
      { mode: "device" },
      {
        provider: "google",
        oauthProof: "id-token-1",
      },
    );

    expect(outcome).toEqual({ kind: "ok", nextUrl: "/dashboard/" });
    expect(keysBindMock).toHaveBeenCalledWith(
      token,
      expect.objectContaining({
        rotate: true,
        stepUpProof: { kind: "oauth", provider: "google", oauthProof: "id-token-1" },
      }),
    );
  });

  it("resolves nextUrl from a pending /pair stash, same as completeOAuthSignIn", async () => {
    const { stashPendingPair } = await import("./pending-pair.js");
    stashPendingPair("eph-pub-base64==");
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpochOAuth(
      bridge,
      token,
      "rt1",
      { mode: "device" },
      {
        provider: "github",
        oauthProof: "gh-token-1",
      },
    );

    expect(outcome).toEqual({ kind: "ok", nextUrl: "/pair/#eph-pub-base64==" });
  });

  it("reports identity-mismatch on a 401 from keys/bind (wrong account at the provider)", async () => {
    keysBindMock.mockRejectedValue(new ApiError("Step-up required to rotate keys", 401));
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpochOAuth(
      bridge,
      token,
      "rt1",
      { mode: "device" },
      {
        provider: "google",
        oauthProof: "id-token-1",
      },
    );

    expect(outcome.kind).toBe("identity-mismatch");
  });

  it("auto-revokes other sessions on 409 and retries bind", async () => {
    keysBindMock
      .mockRejectedValueOnce(
        new ApiError("Other devices are online — pair from one instead of rotating", 409),
      )
      .mockResolvedValueOnce({ success: true, keyEpoch: 2 });
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpochOAuth(
      bridge,
      token,
      "rt1",
      { mode: "device" },
      { provider: "google", oauthProof: "id-token-1" },
    );

    expect(revokeOtherSessionsMock).toHaveBeenCalledOnce();
    expect(keysBindMock).toHaveBeenCalledTimes(2);
    expect(outcome.kind).toBe("ok");
  });

  it("returns an error if revokeOtherSessions itself fails on 409", async () => {
    keysBindMock.mockRejectedValue(
      new ApiError("Other devices are online — pair from one instead of rotating", 409),
    );
    revokeOtherSessionsMock.mockRejectedValue(new ApiError("Server error", 500));
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpochOAuth(
      bridge,
      token,
      "rt1",
      { mode: "device" },
      { provider: "google", oauthProof: "id-token-1" },
    );

    expect(outcome.kind).toBe("error");
  });

  it("resolves to a graceful error (not a thrown/unhandled rejection) when keysChallenge itself fails", async () => {
    // A network blip or an already-expired access token can make keysChallenge — not just
    // keysBind — throw. It must be caught by the same try/catch, or the caller
    // (reset-keys/page.tsx's handleNewPin, which has no try/catch of its own) is left with
    // an unhandled rejection and no way to surface an error to the user.
    keysChallengeMock.mockRejectedValue(new ApiError("Could not reach the Kvy server", 0));
    const bridge = fakeBridge();
    const token = fakeAccessToken("acct_1");

    const outcome = await rotateKeyEpochOAuth(
      bridge,
      token,
      "rt1",
      { mode: "device" },
      {
        provider: "google",
        oauthProof: "id-token-1",
      },
    );

    expect(outcome.kind).toBe("error");
  });
});
