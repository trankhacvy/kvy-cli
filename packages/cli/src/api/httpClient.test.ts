import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./httpClient.js";

describe("createHttpClient", () => {
  it("sends a static authorization header from `headers` when no `getAuthToken` is given", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const client = createHttpClient({
      serverUrl: "http://server.test",
      headers: { authorization: "Bearer static-token" },
      fetchImpl,
    });

    await client.postMessages("sess_1", { localId: "loc_1", content: {} as never });

    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer static-token");
  });

  it("calls `getAuthToken` immediately before every request instead of using a captured value", async () => {
    let currentToken = "token-1";
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const client = createHttpClient({
      serverUrl: "http://server.test",
      getAuthToken: () => currentToken,
      fetchImpl,
    });

    await client.postMessages("sess_1", { localId: "loc_1", content: {} as never });
    currentToken = "token-2"; // e.g. a TokenProvider rotated in the background
    await client.postMessages("sess_1", { localId: "loc_2", content: {} as never });

    expect((calls[0]?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer token-1",
    );
    expect((calls[1]?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer token-2",
    );
  });

  it("sends no authorization header when `getAuthToken` resolves null", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const client = createHttpClient({
      serverUrl: "http://server.test",
      getAuthToken: () => null,
      fetchImpl,
    });

    await client.postMessages("sess_1", { localId: "loc_1", content: {} as never });

    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("invokes `onUnauthorized` on a 401 and returns the (still non-2xx) result to the caller", async () => {
    const onUnauthorized = vi.fn(async () => "new-token");
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 401 }),
    ) as unknown as typeof fetch;

    const client = createHttpClient({
      serverUrl: "http://server.test",
      getAuthToken: () => "stale-token",
      onUnauthorized,
      fetchImpl,
    });

    const result = await client.postMessages("sess_1", { localId: "loc_1", content: {} as never });

    expect(result).toEqual({ ok: false, status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not invoke `onUnauthorized` on a non-401 response", async () => {
    const onUnauthorized = vi.fn(async () => "new-token");
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 500 }),
    ) as unknown as typeof fetch;

    const client = createHttpClient({
      serverUrl: "http://server.test",
      getAuthToken: () => "token",
      onUnauthorized,
      fetchImpl,
    });

    await client.postMessages("sess_1", { localId: "loc_1", content: {} as never });

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("swallows a throwing `onUnauthorized` instead of rejecting the caller's promise", async () => {
    const onUnauthorized = vi.fn(async () => {
      throw new Error("forceRefresh blew up");
    });
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 401 }),
    ) as unknown as typeof fetch;

    const client = createHttpClient({
      serverUrl: "http://server.test",
      getAuthToken: () => "token",
      onUnauthorized,
      fetchImpl,
    });

    await expect(
      client.postMessages("sess_1", { localId: "loc_1", content: {} as never }),
    ).resolves.toEqual({ ok: false, status: 401 });
  });
});
