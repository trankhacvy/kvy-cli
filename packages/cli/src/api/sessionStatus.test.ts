import { describe, expect, it, vi } from "vitest";
import { reportSessionFailed } from "./sessionStatus.js";

function buildDeps(overrides: Partial<Parameters<typeof reportSessionFailed>[0]> = {}) {
  return {
    backendUrl: "http://backend.example",
    accessToken: "test-token",
    fetchImpl: vi.fn(),
    ...overrides,
  };
}

describe("reportSessionFailed", () => {
  it("POSTs status=failed with a bearer token and returns 'ok' on 2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const result = await reportSessionFailed(buildDeps({ fetchImpl }), {
      sessionId: "sess_1",
      error: new Error("boom"),
    });

    expect(result).toEqual({ type: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected fetchImpl to have been called");
    const [url, init] = call;
    expect(url).toBe("http://backend.example/v1/sessions/sess_1/status");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer test-token");
    expect(JSON.parse(init.body)).toEqual({ status: "failed", error: "boom" });
  });

  it("truncates an overlong error message before sending", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const longMessage = "x".repeat(5000);

    await reportSessionFailed(buildDeps({ fetchImpl }), {
      sessionId: "sess_1",
      error: new Error(longMessage),
    });

    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected fetchImpl to have been called");
    const body = JSON.parse(call[1].body);
    expect(body.error.length).toBe(2000);
  });

  it("returns 'http-error' on a non-2xx response, never throws", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    const result = await reportSessionFailed(buildDeps({ fetchImpl }), {
      sessionId: "sess_1",
      error: new Error("boom"),
    });

    expect(result).toEqual({ type: "http-error", status: 404 });
  });

  it("returns 'network-error' when fetch rejects, never throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await reportSessionFailed(buildDeps({ fetchImpl }), {
      sessionId: "sess_1",
      error: new Error("boom"),
    });

    expect(result).toEqual({ type: "network-error", error: "ECONNREFUSED" });
  });
});
