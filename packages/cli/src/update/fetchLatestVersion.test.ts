import { describe, expect, it, vi } from "vitest";
import { fetchLatestVersion } from "./fetchLatestVersion.js";

function fakeFetch(impl: (url: string) => Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe("fetchLatestVersion", () => {
  it("returns the trimmed VERSION file body on success", async () => {
    const fetchImpl = fakeFetch(async () => new Response("0.3.1\n", { status: 200 }));
    await expect(fetchLatestVersion({ repo: "kvy-dev/kvy", fetchImpl })).resolves.toBe("0.3.1");
  });

  it("fetches the cli-latest VERSION asset URL", async () => {
    let requestedUrl: string | undefined;
    const fetchImpl = fakeFetch(async (url) => {
      requestedUrl = url;
      return new Response("0.1.0", { status: 200 });
    });
    await fetchLatestVersion({ repo: "acme/kvy", fetchImpl });
    expect(requestedUrl).toBe("https://github.com/acme/kvy/releases/download/cli-latest/VERSION");
  });

  it("returns null on a non-2xx response", async () => {
    const fetchImpl = fakeFetch(async () => new Response("not found", { status: 404 }));
    await expect(fetchLatestVersion({ repo: "kvy-dev/kvy", fetchImpl })).resolves.toBeNull();
  });

  it("returns null on an empty body", async () => {
    const fetchImpl = fakeFetch(async () => new Response("   ", { status: 200 }));
    await expect(fetchLatestVersion({ repo: "kvy-dev/kvy", fetchImpl })).resolves.toBeNull();
  });

  it("returns null (never throws) when the fetch itself rejects", async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error("network unreachable");
    });
    await expect(fetchLatestVersion({ repo: "kvy-dev/kvy", fetchImpl })).resolves.toBeNull();
  });

  it("returns null when the request times out", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;

    await expect(
      fetchLatestVersion({ repo: "kvy-dev/kvy", fetchImpl, timeoutMs: 5 }),
    ).resolves.toBeNull();
  });
});
