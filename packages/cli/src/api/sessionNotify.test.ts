import { describe, expect, it, vi } from "vitest";
import { reportSessionAttention } from "./sessionNotify.js";

function buildDeps(overrides: Partial<Parameters<typeof reportSessionAttention>[0]> = {}) {
  return {
    backendUrl: "http://backend.example",
    accessToken: "test-token",
    fetchImpl: vi.fn(),
    ...overrides,
  };
}

describe("reportSessionAttention", () => {
  it("POSTs kind=perm with a bearer token and returns 'ok' on 2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const result = await reportSessionAttention(buildDeps({ fetchImpl }), {
      sessionId: "sess_1",
      kind: "perm",
    });

    expect(result).toEqual({ type: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected fetchImpl to have been called");
    const [url, init] = call;
    expect(url).toBe("http://backend.example/v1/sessions/sess_1/notify");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer test-token");
    expect(JSON.parse(init.body)).toEqual({ kind: "perm" });
  });

  it("POSTs kind=question", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await reportSessionAttention(buildDeps({ fetchImpl }), {
      sessionId: "sess_1",
      kind: "question",
    });

    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected fetchImpl to have been called");
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({ kind: "question" });
  });

  it("POSTs kind=done", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await reportSessionAttention(buildDeps({ fetchImpl }), {
      sessionId: "sess_1",
      kind: "done",
    });

    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected fetchImpl to have been called");
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({ kind: "done" });
  });

  it("returns 'http-error' on a non-2xx response, never throws", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    const result = await reportSessionAttention(buildDeps({ fetchImpl }), {
      sessionId: "sess_1",
      kind: "perm",
    });

    expect(result).toEqual({ type: "http-error", status: 404 });
  });

  it("returns 'network-error' when fetch rejects, never throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await reportSessionAttention(buildDeps({ fetchImpl }), {
      sessionId: "sess_1",
      kind: "done",
    });

    expect(result).toEqual({ type: "network-error", error: "ECONNREFUSED" });
  });
});
