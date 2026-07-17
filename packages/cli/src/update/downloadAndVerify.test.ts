import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DownloadVerificationError, downloadAndVerify } from "./downloadAndVerify.js";

function fakeFetch(handlers: Record<string, () => Response>) {
  return vi.fn((url: string) => {
    const handler = handlers[url];
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return Promise.resolve(handler());
  }) as unknown as typeof fetch;
}

const BASE = "https://github.com/falcon-dev/falcon/releases/download/cli-latest";

describe("downloadAndVerify", () => {
  it("resolves the verified bytes when the checksum matches", async () => {
    const payload = Buffer.from("totally a binary");
    const digest = createHash("sha256").update(payload).digest("hex");

    const fetchImpl = fakeFetch({
      [`${BASE}/falcon-darwin-arm64`]: () => new Response(payload),
      [`${BASE}/falcon-darwin-arm64.sha256`]: () =>
        new Response(`${digest}  falcon-darwin-arm64\n`),
    });

    const result = await downloadAndVerify({
      repo: "falcon-dev/falcon",
      assetName: "falcon-darwin-arm64",
      fetchImpl,
    });
    expect(result.equals(payload)).toBe(true);
  });

  it("throws DownloadVerificationError on a checksum mismatch", async () => {
    const payload = Buffer.from("tampered");
    const fetchImpl = fakeFetch({
      [`${BASE}/falcon-linux-x64`]: () => new Response(payload),
      [`${BASE}/falcon-linux-x64.sha256`]: () =>
        new Response("0000000000000000000000000000000000000000000000000000000000000000  falcon-linux-x64\n"),
    });

    await expect(
      downloadAndVerify({ repo: "falcon-dev/falcon", assetName: "falcon-linux-x64", fetchImpl }),
    ).rejects.toThrow(DownloadVerificationError);
  });

  it("throws DownloadVerificationError on an HTTP failure", async () => {
    const fetchImpl = fakeFetch({
      [`${BASE}/falcon-linux-x64`]: () => new Response("nope", { status: 500 }),
      [`${BASE}/falcon-linux-x64.sha256`]: () => new Response("deadbeef  falcon-linux-x64\n"),
    });

    await expect(
      downloadAndVerify({ repo: "falcon-dev/falcon", assetName: "falcon-linux-x64", fetchImpl }),
    ).rejects.toThrow(DownloadVerificationError);
  });
});
