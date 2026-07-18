import { describe, expect, it } from "vitest";
import { formatBytes, formatTokenCount } from "./format";

describe("formatBytes", () => {
  it("renders sub-KB sizes in bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("renders KB/MB/GB with one decimal under 10 units, none at or above", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("never throws on negative or non-finite input", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("formatTokenCount (UsageChip, W4.6)", () => {
  it("renders sub-1000 counts as plain numbers", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(4)).toBe("4");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("renders k/M with one decimal under 10 units, none at or above", () => {
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(10_000)).toBe("10k");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
  });

  it("never throws on negative or non-finite input", () => {
    expect(formatTokenCount(-5)).toBe("0");
    expect(formatTokenCount(Number.NaN)).toBe("0");
  });
});
