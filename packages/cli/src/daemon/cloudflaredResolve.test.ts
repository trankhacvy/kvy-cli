import { describe, expect, it, vi } from "vitest";
import { detectCloudflared } from "./cloudflaredResolve.js";

describe("detectCloudflared", () => {
  it("reports installed + version + path when cloudflared is found", async () => {
    const runVersion = vi
      .fn()
      .mockResolvedValue("cloudflared version 2024.6.1 (built 2024-06-10-1200 UTC)\n");
    const runWhich = vi.fn().mockResolvedValue("/opt/homebrew/bin/cloudflared\n");

    await expect(detectCloudflared({ runVersion, runWhich })).resolves.toEqual({
      installed: true,
      version: "2024.6.1",
      path: "/opt/homebrew/bin/cloudflared",
    });
  });

  it("reports not installed when the binary is missing (ENOENT-style failure)", async () => {
    const runVersion = vi.fn().mockResolvedValue(null);
    const runWhich = vi.fn().mockResolvedValue(null);

    await expect(detectCloudflared({ runVersion, runWhich })).resolves.toEqual({
      installed: false,
    });
    // `which` is never called once `--version` itself already failed.
    expect(runWhich).not.toHaveBeenCalled();
  });

  it("degrades to installed:true with no version when the output doesn't parse", async () => {
    const runVersion = vi.fn().mockResolvedValue("some unexpected future output format\n");
    const runWhich = vi.fn().mockResolvedValue(null);

    await expect(detectCloudflared({ runVersion, runWhich })).resolves.toEqual({
      installed: true,
    });
  });

  it("never throws even if runWhich rejects", async () => {
    const runVersion = vi.fn().mockResolvedValue("cloudflared version 2024.6.1\n");
    const runWhich = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(detectCloudflared({ runVersion, runWhich })).resolves.toEqual({
      installed: true,
      version: "2024.6.1",
    });
  });
});
