import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CryptoBridgeClient } from "@/crypto";
import { createMemoryStorage } from "./__tests__/test-storage.js";

const { registerMock, keysChallengeMock, keysBindMock } = vi.hoisted(() => ({
  registerMock: vi.fn(),
  keysChallengeMock: vi.fn(),
  keysBindMock: vi.fn(),
}));

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    register: registerMock,
    keysChallenge: keysChallengeMock,
    keysBind: keysBindMock,
  };
});

const { ApiError } = await import("./api.js");
const { completeOAuthSignIn } = await import("./complete-oauth-sign-in.js");

/** A valid-shaped JWT (`{sub}` payload) — this flow only ever decodes `sub` client-side,
 * never verifies a signature (the server is the actual authority). */
function fakeAccessToken(sub: string): string {
  const header = btoa(JSON.stringify({ alg: "none" }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function fakeBridge(overrides: Partial<CryptoBridgeClient> = {}): CryptoBridgeClient {
  const notImplemented = () => {
    throw new Error("not implemented in this fake");
  };
  return {
    init: async () => undefined,
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
    getIdentity: async () => null,
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

// auth-ux-overhaul-fix-plan.md Fix 4, Part A2: `/v1/auth/register` is find-or-create, so
// (unlike password sign-up) a returning user reusing their OWN key material on this
// browser is the normal, correct case — but only when `getIdentity` is scoped to THIS
// account. There was no test of this module at all before this fix.
describe("completeOAuthSignIn", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { sessionStorage: createMemoryStorage() };
    registerMock.mockReset();
    keysChallengeMock.mockReset().mockResolvedValue({ nonce: "n1" });
    keysBindMock.mockReset().mockResolvedValue({ success: true, keyEpoch: 1 });
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it("reuses this account's own identity — init is NOT called and keysBind is skipped", async () => {
    const token = fakeAccessToken("acct_1");
    registerMock.mockResolvedValue({ success: true, token, refreshToken: "rt1" });
    const initSpy = vi.fn(async () => undefined);
    const bridge = fakeBridge({
      init: initSpy,
      getIdentity: async (accountId?: string) =>
        accountId === "acct_1" ? { signPubKey: "own-sign", contentPubKey: "own-content" } : null,
    });

    const outcome = await completeOAuthSignIn(bridge, "google", "id-token-1", { mode: "device" });

    expect(outcome).toEqual({
      kind: "existing-identity",
      nextUrl: "/dashboard/",
      refreshToken: "rt1",
    });
    expect(initSpy).not.toHaveBeenCalled();
    expect(keysBindMock).not.toHaveBeenCalled();
  });

  it("provisions fresh key material, scoped to the account id, when this browser has none (or a foreign record)", async () => {
    const token = fakeAccessToken("acct_2");
    registerMock.mockResolvedValue({ success: true, token, refreshToken: "rt2" });
    let loaded: { signPubKey: string; contentPubKey: string } | null = null;
    const initSpy = vi.fn(
      async (_masterSecret: Uint8Array, _refreshToken: string, _accountId: string) => {
        loaded = { signPubKey: "new-sign", contentPubKey: "new-content" };
      },
    );
    const bridge = fakeBridge({
      init: initSpy,
      // Scoped: returns null for "acct_2" even though SOME record exists (e.g. a foreign
      // account's), and returns the newly-provisioned identity once `init` has run.
      getIdentity: async (accountId?: string) => (accountId === "acct_2" ? loaded : null),
    });

    const outcome = await completeOAuthSignIn(bridge, "google", "id-token-1", { mode: "device" });

    expect(initSpy).toHaveBeenCalledOnce();
    expect(initSpy).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "rt2",
      "acct_2",
      expect.objectContaining({ mode: "device" }),
    );
    expect(keysBindMock).toHaveBeenCalledWith(
      token,
      expect.objectContaining({ signPubKey: "sign-pub", contentPubKey: "content-pub" }),
    );
    expect(outcome).toEqual({ kind: "new-identity", nextUrl: "/dashboard/" });
  });

  it("surfaces a keysBind 409 to the caller instead of swallowing it", async () => {
    const token = fakeAccessToken("acct_3");
    registerMock.mockResolvedValue({ success: true, token, refreshToken: "rt3" });
    keysBindMock.mockRejectedValue(new ApiError("Key mismatch; rotation must be explicit", 409));
    let loaded: { signPubKey: string; contentPubKey: string } | null = null;
    const bridge = fakeBridge({
      init: async () => {
        loaded = { signPubKey: "new-sign", contentPubKey: "new-content" };
      },
      getIdentity: async () => loaded,
    });

    await expect(
      completeOAuthSignIn(bridge, "google", "id-token-1", { mode: "device" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
