import { deriveKeyTree, getRandomBytes } from "@falcon/crypto";
import { describe, expect, it, vi } from "vitest";
import type { FalconCredentials } from "../auth/credentials.js";
import { plaintextFallbackKeyMaterial } from "../auth/keyMaterial.js";
import type { Logger } from "../logger.js";
import { type PreflightWithReauthDeps, runPreflightWithReauth } from "./startPreflight.js";

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function credentialsFor(secret: Uint8Array): FalconCredentials {
  return { refreshToken: "refresh-1", keyMaterial: plaintextFallbackKeyMaterial(secret) };
}

/** A `fetch` that answers `POST /v1/auth/refresh` with either 401 (dead) or a fresh pair. */
function refreshFetch(outcome: "dead" | "ok"): typeof fetch {
  return vi.fn(async () => {
    if (outcome === "dead") return new Response("{}", { status: 401 });
    return Response.json({ accessToken: "access-1", refreshToken: "refresh-2" });
  }) as unknown as typeof fetch;
}

function baseDeps(overrides: Partial<PreflightWithReauthDeps> = {}): PreflightWithReauthDeps {
  const secret = getRandomBytes(32);
  return {
    homeDir: "/home/fake",
    backendUrl: "http://backend.invalid",
    readCredentials: () => credentialsFor(secret),
    readDaemonState: async () => ({
      pid: 1,
      port: 2,
      version: "0.0.0",
      startedAt: 0,
      machineId: "machine-1",
    }),
    fetchImpl: refreshFetch("ok"),
    sleep: async () => {},
    now: () => 0,
    logger: noopLogger,
    interactive: true,
    ensureLoggedIn: async () => ({ ok: true }),
    reloadDaemonAuth: async () => true,
    write: () => {},
    ...overrides,
  };
}

describe("runPreflightWithReauth", () => {
  it("resolves credentials, key material, machineId and a token in one pass", async () => {
    const result = await runPreflightWithReauth(baseDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preflight.machineId).toBe("machine-1");
    expect(result.preflight.accessToken).toBe("access-1");
    expect(result.preflight.masterSecret).toHaveLength(32);
  });

  it("re-pairs inline and RE-DERIVES the content key when the refresh token is dead", async () => {
    const oldSecret = getRandomBytes(32);
    const newSecret = getRandomBytes(32);
    let paired = false;

    // Models the REAL `ensureLoggedIn`, not just "a fake that always re-pairs" — the bug
    // this fix closes (E2E-6.4) was exactly that the real function short-circuits on a
    // present-but-dead credentials file unless told `{ force: true }`. A stub that pairs
    // unconditionally would mask a regression where `runPreflightWithReauth` stops passing
    // `force`.
    const ensureLoggedIn = vi.fn(
      async (_logger: Logger, _homeDir: string, options?: { force?: boolean }) => {
        if (!options?.force) return { ok: true }; // the short-circuit a stale file causes
        paired = true;
        return { ok: true };
      },
    );

    const result = await runPreflightWithReauth(
      baseDeps({
        readCredentials: () => credentialsFor(paired ? newSecret : oldSecret),
        // Dead until the re-pair happens, then healthy.
        fetchImpl: vi.fn(async () => {
          if (!paired) return new Response("{}", { status: 401 });
          return Response.json({ accessToken: "access-2", refreshToken: "refresh-3" });
        }) as unknown as typeof fetch,
        ensureLoggedIn,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The whole preflight re-ran: the content key comes from the NEW secret, not the
    // one resolved before the re-pair. Patching only the access token would have kept
    // the old key and silently encrypted the session under a dead epoch.
    expect(result.preflight.masterSecret).toEqual(newSecret);
    expect(result.preflight.contentKeyPair.publicKey).toEqual(
      deriveKeyTree(newSecret).content.publicKey,
    );
    expect(result.preflight.accessToken).toBe("access-2");
    expect(ensureLoggedIn).toHaveBeenCalledWith(noopLogger, "/home/fake", { force: true });
  });

  it("asks the daemon to reload credentials after a re-pair", async () => {
    const reloadDaemonAuth = vi.fn(async () => true);
    let paired = false;
    await runPreflightWithReauth(
      baseDeps({
        fetchImpl: vi.fn(async () => {
          if (!paired) return new Response("{}", { status: 401 });
          return Response.json({ accessToken: "a", refreshToken: "r" });
        }) as unknown as typeof fetch,
        ensureLoggedIn: async () => {
          paired = true;
          return { ok: true };
        },
        reloadDaemonAuth,
      }),
    );

    expect(reloadDaemonAuth).toHaveBeenCalledWith("/home/fake");
  });

  it("never re-pairs without a terminal", async () => {
    const ensureLoggedIn = vi.fn(async () => ({ ok: true }));
    const result = await runPreflightWithReauth(
      baseDeps({ interactive: false, fetchImpl: refreshFetch("dead"), ensureLoggedIn }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason === "error" && result.message).toContain(
      "not logged in",
    );
    expect(ensureLoggedIn).not.toHaveBeenCalled();
  });

  it("gives up honestly when the re-pair itself fails", async () => {
    const result = await runPreflightWithReauth(
      baseDeps({
        fetchImpl: refreshFetch("dead"),
        ensureLoggedIn: async () => ({ ok: false, message: "cancelled\n" }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason === "error" && result.message).toBe("cancelled\n");
  });

  it("reports a missing machineId as an error, not as needing re-auth", async () => {
    let now = 0;
    const result = await runPreflightWithReauth(
      baseDeps({
        readDaemonState: async () => ({
          pid: 1,
          port: 2,
          version: "0.0.0",
          startedAt: 0,
          machineId: undefined,
        }),
        now: () => {
          const value = now;
          now += 1000;
          return value;
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason === "error" && result.message).toContain(
      "hasn't finished connecting",
    );
  });
});
