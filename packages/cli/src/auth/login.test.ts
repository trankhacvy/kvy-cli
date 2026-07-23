import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pairDeviceMock = vi.fn();
const openBrowserMock = vi.fn();
const displayPairingQrCodeMock = vi.fn();
const writeCredentialsMock = vi.fn();

vi.mock("./pair.js", () => ({ pairDevice: pairDeviceMock }));
vi.mock("./browser.js", () => ({ openBrowser: openBrowserMock }));
vi.mock("./qrcode.js", () => ({ displayPairingQrCode: displayPairingQrCodeMock }));
vi.mock("./credentials.js", () => ({ writeCredentials: writeCredentialsMock }));

const { runAuthLogin } = await import("./login.js");

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function joinedOutput(stdout: { mock: { calls: unknown[][] } }): string {
  return stdout.mock.calls.map((call) => call[0]).join("");
}

beforeEach(() => {
  pairDeviceMock.mockReset();
  openBrowserMock.mockReset().mockResolvedValue(false);
  displayPairingQrCodeMock.mockReset();
  writeCredentialsMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAuthLogin", () => {
  it("writes credentials, logs success, and exits 0 on a successful pairing", async () => {
    const masterSecret = new Uint8Array(32).fill(7);
    pairDeviceMock.mockImplementation(
      async (options: { onPairingUrlReady: (u: string) => unknown }) => {
        await options.onPairingUrlReady("http://web.invalid/pair#frag");
        return {
          ok: true,
          result: { token: "jwt-token", refreshToken: "refresh-token-1", masterSecret },
        };
      },
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = fakeLogger();

    const code = await runAuthLogin(logger);

    expect(code).toBe(0);
    expect(writeCredentialsMock).toHaveBeenCalledTimes(1);
    const written = writeCredentialsMock.mock.calls[0]?.[0];
    expect(written.refreshToken).toBe("refresh-token-1");
    expect(typeof written.masterSecretOrContentBundle).toBe("string");
    expect(displayPairingQrCodeMock).toHaveBeenCalledWith("http://web.invalid/pair#frag");
    expect(logger.info).toHaveBeenCalledWith("auth login: succeeded");
    expect(joinedOutput(stdout)).toContain("Logged in to Falcon.");
  });

  it("prints the opened-browser message when openBrowser succeeds", async () => {
    openBrowserMock.mockResolvedValue(true);
    pairDeviceMock.mockImplementation(
      async (options: { onPairingUrlReady: (u: string) => unknown }) => {
        await options.onPairingUrlReady("http://web.invalid/pair#frag");
        return { ok: false, reason: "cancelled" };
      },
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runAuthLogin(fakeLogger());

    expect(joinedOutput(stdout)).toContain("Opened your browser");
  });

  it.each([
    ["request-failed", "Could not reach the Falcon server"],
    ["expired", "Pairing request expired"],
    ["cancelled", "Sign-in cancelled."],
    ["decrypt-failed", "unreadable response"],
  ] as const)("prints a message and exits 1 for reason=%s", async (reason, expectedText) => {
    pairDeviceMock.mockResolvedValue({ ok: false, reason });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = fakeLogger();

    const code = await runAuthLogin(logger);

    expect(code).toBe(1);
    expect(writeCredentialsMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("auth login: pairing did not complete", { reason });
    expect(joinedOutput(stdout)).toContain(expectedText);
  });

  it("registers and unregisters its own SIGINT handler", async () => {
    pairDeviceMock.mockResolvedValue({ ok: false, reason: "cancelled" });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const before = process.listenerCount("SIGINT");

    await runAuthLogin(fakeLogger());

    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
