import { describe, expect, it, vi } from "vitest";
import { DeviceFlowError, pollForToken, requestDeviceCode } from "./deviceFlow.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

/** Wraps a plain `() => Promise<Response>` fake into something matching `typeof fetch`'s real parameter types (`RequestInfo | URL`, optional `init`) — the calls below only ever pass a plain string URL, so tests can assert on that directly via `.mock.calls`. */
function fetchMock(impl: () => Promise<Response>) {
  return vi.fn((_input: string | URL | Request, _init?: RequestInit) => impl());
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(init?.body as string) as Record<string, unknown>;
}

describe("requestDeviceCode", () => {
  it("posts to github's device code endpoint and maps the response", async () => {
    const fetchImpl = fetchMock(async () =>
      jsonResponse({
        device_code: "dc-1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 900,
      }),
    );

    const result = await requestDeviceCode({ clientId: "client-1", fetchImpl });

    expect(result).toEqual({
      deviceCode: "dc-1",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      interval: 5,
      expiresIn: 900,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://github.com/login/device/code",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(bodyOf(init)).toEqual({ client_id: "client-1", scope: "repo" });
  });

  it("uses a custom scope when given", async () => {
    const fetchImpl = fetchMock(async () =>
      jsonResponse({
        device_code: "dc",
        user_code: "u",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 900,
      }),
    );
    await requestDeviceCode({ clientId: "client-1", scope: "repo read:checks", fetchImpl });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(bodyOf(init).scope).toBe("repo read:checks");
  });

  it("throws a request-failed DeviceFlowError on a non-2xx response", async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({}, false, 401));
    await expect(requestDeviceCode({ clientId: "client-1", fetchImpl })).rejects.toThrow(
      DeviceFlowError,
    );
  });
});

const noSleep = async () => {};

describe("pollForToken", () => {
  it("resolves once the response includes an access_token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "gho_x", scope: "repo" }));

    const result = await pollForToken({
      clientId: "client-1",
      deviceCode: "dc-1",
      interval: 5,
      fetchImpl,
      sleep: noSleep,
    });

    expect(result).toEqual({ accessToken: "gho_x", scope: "repo" });
  });

  it("keeps polling through authorization_pending until success", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) return jsonResponse({ error: "authorization_pending" });
      return jsonResponse({ access_token: "gho_y", scope: "repo" });
    });

    const result = await pollForToken({
      clientId: "client-1",
      deviceCode: "dc-1",
      interval: 5,
      fetchImpl,
      sleep: noSleep,
    });

    expect(result.accessToken).toBe("gho_y");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("honors slow_down by increasing the sleep interval by 5s", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return jsonResponse({ error: "slow_down" });
      return jsonResponse({ access_token: "gho_z", scope: "repo" });
    });
    const sleep = vi.fn(noSleep);

    await pollForToken({ clientId: "client-1", deviceCode: "dc-1", interval: 5, fetchImpl, sleep });

    expect(sleep).toHaveBeenNthCalledWith(1, 5000);
    expect(sleep).toHaveBeenNthCalledWith(2, 10000);
  });

  it("throws an expired_token DeviceFlowError on expired_token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "expired_token" }));

    await expect(
      pollForToken({
        clientId: "client-1",
        deviceCode: "dc-1",
        interval: 5,
        fetchImpl,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: "expired_token" });
  });

  it("throws an access_denied DeviceFlowError on access_denied", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "access_denied" }));

    await expect(
      pollForToken({
        clientId: "client-1",
        deviceCode: "dc-1",
        interval: 5,
        fetchImpl,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it("throws an unknown DeviceFlowError for an unrecognized error shape rather than looping forever", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "something_new" }));

    await expect(
      pollForToken({
        clientId: "client-1",
        deviceCode: "dc-1",
        interval: 5,
        fetchImpl,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: "unknown" });
  });

  it("throws a timeout DeviceFlowError once maxAttempts is exceeded", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "authorization_pending" }));

    await expect(
      pollForToken({
        clientId: "client-1",
        deviceCode: "dc-1",
        interval: 5,
        fetchImpl,
        sleep: noSleep,
        maxAttempts: 3,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
