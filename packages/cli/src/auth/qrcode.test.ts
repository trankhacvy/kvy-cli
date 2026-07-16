import { afterEach, describe, expect, it, vi } from "vitest";
import { displayPairingQrCode } from "./qrcode.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("displayPairingQrCode", () => {
  it("writes the generated QR code to stdout", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    displayPairingQrCode("http://web.invalid/pair#frag");

    expect(stdout).toHaveBeenCalledTimes(1);
    const output = stdout.mock.calls[0]?.[0] as string;
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });
});
