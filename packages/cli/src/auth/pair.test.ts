import {
  decodeBase64,
  encodeBase64,
  getRandomBytes,
  libsodiumEncryptForPublicKey,
} from "@falcon/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { delay, pairDevice } from "./pair.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("pairDevice", () => {
  it("returns request-failed when the initial POST /v1/auth/pair can't be reached", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const onPairingUrlReady = vi.fn();

    const outcome = await pairDevice({
      backendUrl: "http://example.invalid",
      frontendUrl: "http://web.invalid",
      onPairingUrlReady,
    });

    expect(outcome).toEqual({ ok: false, reason: "request-failed" });
    expect(onPairingUrlReady).not.toHaveBeenCalled();
  });

  it("returns expired immediately if the fresh pair request already reports expired", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ state: "expired" }));

    const outcome = await pairDevice({
      backendUrl: "http://example.invalid",
      frontendUrl: "http://web.invalid",
      onPairingUrlReady: vi.fn(),
    });

    expect(outcome).toEqual({ ok: false, reason: "expired" });
  });

  it("prints a base64url ephPub fragment under the frontend URL", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ state: "pending" }));
    const onPairingUrlReady = vi.fn();
    const controller = new AbortController();

    const outcome = await pairDevice({
      backendUrl: "http://example.invalid",
      frontendUrl: "http://web.invalid",
      signal: controller.signal,
      onPairingUrlReady: (url) => {
        onPairingUrlReady(url);
        controller.abort(); // stop the poll loop as soon as we've seen the URL
      },
    });

    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
    expect(onPairingUrlReady).toHaveBeenCalledTimes(1);
    const url = onPairingUrlReady.mock.calls[0]?.[0] as string;
    expect(url.startsWith("http://web.invalid/pair#")).toBe(true);
    const fragment = url.split("#")[1] ?? "";
    expect(fragment.length).toBeGreaterThan(0);
    expect(fragment).not.toMatch(/[+/=]/); // base64url, not padded base64
  });

  it("polls to authorized and decrypts the sealed masterSecret", async () => {
    const masterSecret = getRandomBytes(32);
    const seenEphPubs: string[] = [];
    let statusCalls = 0;

    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/auth/pair/status")) {
        statusCalls++;
        return jsonResponse({ status: statusCalls === 1 ? "pending" : "authorized" });
      }
      const body = JSON.parse((init?.body as string) ?? "{}") as { ephPub: string };
      seenEphPubs.push(body.ephPub);
      if (statusCalls === 0) {
        return jsonResponse({ state: "pending" });
      }
      // Matches the real approver's wire format exactly (packages/web/src/crypto/
      // worker-handler.ts's `sealForPeer`: `[version(1) | masterSecret(32) |
      // refreshToken]`, issue-4-plan.md §6.3) — sealing the bare masterSecret here
      // would let this test pass while the real pairing flow (which has the
      // version-byte prefix and the trailing refresh token) still failed to decode.
      const refreshTokenBytes = new TextEncoder().encode("refresh-token-1");
      const versionedPayload = new Uint8Array([0x01, ...masterSecret, ...refreshTokenBytes]);
      const sealed = libsodiumEncryptForPublicKey(versionedPayload, decodeBase64(body.ephPub));
      return jsonResponse({
        state: "authorized",
        response: encodeBase64(sealed),
      });
    });

    const outcome = await pairDevice({
      backendUrl: "http://example.invalid",
      frontendUrl: "http://web.invalid",
      pollIntervalMs: 0,
      onPairingUrlReady: () => {},
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.refreshToken).toBe("refresh-token-1");
      expect(outcome.result.masterSecret).toEqual(masterSecret);
    }
    // Same ephemeral keypair used for every request across the whole dance.
    expect(new Set(seenEphPubs).size).toBe(1);
  });

  it("returns decrypt-failed when the sealed box doesn't open with our ephemeral key", async () => {
    let posts = 0;
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/v1/auth/pair/status")) {
        return jsonResponse({ status: "authorized" });
      }
      posts++;
      if (posts === 1) return jsonResponse({ state: "pending" });
      // Sealed to an unrelated keypair — our ephemeral secret can't open it.
      const other = getRandomBytes(32);
      const bogusRecipient = getRandomBytes(32);
      const sealed = libsodiumEncryptForPublicKey(other, bogusRecipient);
      return jsonResponse({
        state: "authorized",
        response: encodeBase64(sealed),
      });
    });

    const outcome = await pairDevice({
      backendUrl: "http://example.invalid",
      frontendUrl: "http://web.invalid",
      pollIntervalMs: 0,
      onPairingUrlReady: () => {},
    });

    expect(outcome).toEqual({ ok: false, reason: "decrypt-failed" });
  });

  it("returns decrypt-failed when the decrypted payload has the wrong version byte or length", async () => {
    let posts = 0;
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/auth/pair/status")) {
        return jsonResponse({ status: "authorized" });
      }
      posts++;
      if (posts === 1) return jsonResponse({ state: "pending" });
      const body = JSON.parse((init?.body as string) ?? "{}") as { ephPub: string };
      // Opens fine (correct recipient), but isn't the expected
      // `[version | masterSecret | refreshToken]` shape — a bare 32-byte payload with
      // no version prefix (and no trailing refresh token), exactly the bug this test
      // guards against regressing to.
      const bareMasterSecret = getRandomBytes(32);
      const sealed = libsodiumEncryptForPublicKey(bareMasterSecret, decodeBase64(body.ephPub));
      return jsonResponse({
        state: "authorized",
        response: encodeBase64(sealed),
      });
    });

    const outcome = await pairDevice({
      backendUrl: "http://example.invalid",
      frontendUrl: "http://web.invalid",
      pollIntervalMs: 0,
      onPairingUrlReady: () => {},
    });

    expect(outcome).toEqual({ ok: false, reason: "decrypt-failed" });
  });

  it("returns expired when the status endpoint reports expired mid-poll", async () => {
    let posts = 0;
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/v1/auth/pair/status")) {
        return jsonResponse({ status: "expired" });
      }
      posts++;
      return jsonResponse({ state: "pending" });
    });

    const outcome = await pairDevice({
      backendUrl: "http://example.invalid",
      frontendUrl: "http://web.invalid",
      pollIntervalMs: 0,
      onPairingUrlReady: () => {},
    });

    expect(outcome).toEqual({ ok: false, reason: "expired" });
    expect(posts).toBe(1);
  });

  it("returns expired immediately when the follow-up POST reports expired after status said authorized", async () => {
    // Server-side expiry racing the last poll tick: GET /status says
    // "authorized", but by the time the follow-up POST /v1/auth/pair lands
    // to fetch the token + sealed box, the request has expired server-side.
    let posts = 0;
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/v1/auth/pair/status")) {
        return jsonResponse({ status: "authorized" });
      }
      posts++;
      if (posts === 1) return jsonResponse({ state: "pending" });
      return jsonResponse({ state: "expired" });
    });

    const outcome = await pairDevice({
      backendUrl: "http://example.invalid",
      frontendUrl: "http://web.invalid",
      pollIntervalMs: 0,
      onPairingUrlReady: () => {},
    });

    expect(outcome).toEqual({ ok: false, reason: "expired" });
    expect(posts).toBe(2);
  });

  it("returns cancelled when the abort signal fires mid-poll", async () => {
    const controller = new AbortController();
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/v1/auth/pair/status")) {
        controller.abort();
        return jsonResponse({ status: "pending" });
      }
      return jsonResponse({ state: "pending" });
    });

    const outcome = await pairDevice({
      backendUrl: "http://example.invalid",
      frontendUrl: "http://web.invalid",
      pollIntervalMs: 0,
      signal: controller.signal,
      onPairingUrlReady: () => {},
    });

    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
  });
});

describe("delay (Issue #11: leaked abort listeners on the never-aborted path)", () => {
  it("removes its abort listener on the normal timer-resolves path too, not just on abort", async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    // Mirrors `pairDevice`'s poll loop: the same long-lived signal reused
    // across many ticks, none of which ever abort — the exact shape that
    // used to accumulate a dangling listener per tick until Node's default
    // max-listener threshold tripped a `MaxListenersExceededWarning`.
    for (let i = 0; i < 20; i++) {
      await delay(0, controller.signal);
    }

    expect(addSpy).toHaveBeenCalledTimes(20);
    expect(removeSpy).toHaveBeenCalledTimes(20);
    expect(controller.signal.aborted).toBe(false);
  });
});
