import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openMock = vi.fn();
vi.mock("open", () => ({ default: openMock }));

const { openBrowser } = await import("./browser.js");

let originalIsTTY: boolean | undefined;
let originalCI: string | undefined;
let originalHeadless: string | undefined;

beforeEach(() => {
  openMock.mockReset();
  originalIsTTY = process.stdout.isTTY;
  originalCI = process.env.CI;
  originalHeadless = process.env.HEADLESS;
  delete process.env.CI;
  delete process.env.HEADLESS;
});

afterEach(() => {
  Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
  if (originalCI === undefined) delete process.env.CI;
  else process.env.CI = originalCI;
  if (originalHeadless === undefined) delete process.env.HEADLESS;
  else process.env.HEADLESS = originalHeadless;
  vi.restoreAllMocks();
});

describe("openBrowser", () => {
  it("returns false without attempting to open when stdout is not a TTY", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

    const result = await openBrowser("http://example.invalid");

    expect(result).toBe(false);
    expect(openMock).not.toHaveBeenCalled();
  });

  it("returns false without attempting to open under CI even with a TTY", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.env.CI = "1";

    const result = await openBrowser("http://example.invalid");

    expect(result).toBe(false);
    expect(openMock).not.toHaveBeenCalled();
  });

  it("returns false without attempting to open under HEADLESS even with a TTY", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.env.HEADLESS = "1";

    const result = await openBrowser("http://example.invalid");

    expect(result).toBe(false);
    expect(openMock).not.toHaveBeenCalled();
  });

  it("calls open() and returns true on a TTY with no CI/HEADLESS", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    openMock.mockResolvedValue(undefined);

    const result = await openBrowser("http://example.invalid");

    expect(result).toBe(true);
    expect(openMock).toHaveBeenCalledWith("http://example.invalid");
  });

  it("returns false (never throws) when open() rejects", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    openMock.mockRejectedValue(new Error("no browser found"));

    const result = await openBrowser("http://example.invalid");

    expect(result).toBe(false);
  });
});
