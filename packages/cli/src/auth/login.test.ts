import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pairDeviceMock = vi.fn();
const openBrowserMock = vi.fn();
const displayQrCodeMock = vi.fn();
const writeCredentialsMock = vi.fn();
const readCredentialsMock = vi.fn();
const clearCredentialsMock = vi.fn();
const wrapWithDeviceKeyMock = vi.fn();

vi.mock("./pair.js", () => ({ pairDevice: pairDeviceMock }));
vi.mock("./browser.js", () => ({ openBrowser: openBrowserMock }));
vi.mock("./qrcode.js", () => ({ displayQrCode: displayQrCodeMock }));
vi.mock("./credentials.js", () => ({
  writeCredentials: writeCredentialsMock,
  readCredentials: readCredentialsMock,
  clearCredentials: clearCredentialsMock,
}));
// `wrapNewKeyMaterial` always device-key wraps now — mocked so this suite never touches
// a real OS vault or a real `~/.falcon/device.key`.
vi.mock("./deviceKey.js", () => ({
  wrapWithDeviceKey: wrapWithDeviceKeyMock,
}));

const { runAuthLogin, ensureLoggedIn } = await import("./login.js");

/** Temporarily overrides `process.stdin.isTTY` for one test, restoring it after. */
function withStdinTTY(value: boolean | undefined, fn: () => Promise<void>): Promise<void> {
  const stdin = process.stdin as unknown as { isTTY: boolean | undefined };
  const original = stdin.isTTY;
  stdin.isTTY = value;
  return fn().finally(() => {
    stdin.isTTY = original;
  });
}

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function joinedOutput(stdout: { mock: { calls: unknown[][] } }): string {
  return stdout.mock.calls.map((call) => call[0]).join("");
}

beforeEach(() => {
  pairDeviceMock.mockReset();
  openBrowserMock.mockReset().mockResolvedValue(false);
  displayQrCodeMock.mockReset();
  writeCredentialsMock.mockReset();
  readCredentialsMock.mockReset().mockReturnValue(null);
  clearCredentialsMock.mockReset();
  wrapWithDeviceKeyMock.mockReset().mockReturnValue({ v: 1, nonce: "n", ct: "c" });
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
          result: { refreshToken: "refresh-token-1", masterSecret },
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
    expect(written.keyMaterial).toEqual({ mode: "device", wrapped: { v: 1, nonce: "n", ct: "c" } });
    expect(wrapWithDeviceKeyMock).toHaveBeenCalledWith(masterSecret, expect.any(String));
    expect(displayQrCodeMock).toHaveBeenCalledWith("http://web.invalid/pair#frag");
    expect(logger.info).toHaveBeenCalledWith("auth login: succeeded");
    expect(joinedOutput(stdout)).toContain("✓ Connected");
    expect(joinedOutput(stdout)).toContain("Starting your session");
  });

  it("prints the pairing URL even when the browser opened successfully", async () => {
    openBrowserMock.mockResolvedValue(true);
    pairDeviceMock.mockImplementation(
      async (options: { onPairingUrlReady: (u: string) => unknown }) => {
        await options.onPairingUrlReady("http://web.invalid/pair#frag");
        return { ok: false, reason: "cancelled" };
      },
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runAuthLogin(fakeLogger());

    expect(joinedOutput(stdout)).toContain("Opening your browser");
    expect(joinedOutput(stdout)).toContain("http://web.invalid/pair#frag");
  });

  it("prints the pairing URL when the browser could not be opened", async () => {
    openBrowserMock.mockResolvedValue(false);
    pairDeviceMock.mockImplementation(
      async (options: { onPairingUrlReady: (u: string) => unknown }) => {
        await options.onPairingUrlReady("http://web.invalid/pair#frag");
        return { ok: false, reason: "cancelled" };
      },
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runAuthLogin(fakeLogger());

    expect(joinedOutput(stdout)).toContain("http://web.invalid/pair#frag");
  });

  it.each([
    ["request-failed", "Could not reach the Falcon server"],
    ["expired", "That sign-in link expired"],
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

describe("ensureLoggedIn", () => {
  it("returns ok immediately when credentials already exist, without touching pairing", async () => {
    readCredentialsMock.mockReturnValue({
      refreshToken: "t",
      keyMaterial: { mode: "device", wrapped: {} },
    });

    const result = await ensureLoggedIn(fakeLogger(), "/home/fake");

    expect(result).toEqual({ ok: true });
    expect(pairDeviceMock).not.toHaveBeenCalled();
  });

  it("fails fast with the non-interactive message when no credentials and not a TTY", async () =>
    withStdinTTY(undefined, async () => {
      const result = await ensureLoggedIn(fakeLogger(), "/home/fake");

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toContain("not logged in");
      expect(result.ok === false && result.message).toContain("no terminal here");
      expect(pairDeviceMock).not.toHaveBeenCalled();
    }));

  it("auto-triggers the pairing flow at a real TTY and succeeds when pairing succeeds", async () =>
    withStdinTTY(true, async () => {
      const masterSecret = new Uint8Array(32).fill(1);
      pairDeviceMock.mockImplementation(
        async (options: { onPairingUrlReady: (u: string) => unknown }) => {
          await options.onPairingUrlReady("http://web.invalid/pair#frag");
          return { ok: true, result: { refreshToken: "refresh-token-1", masterSecret } };
        },
      );
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const result = await ensureLoggedIn(fakeLogger(), "/home/fake");

      expect(result).toEqual({ ok: true });
      expect(pairDeviceMock).toHaveBeenCalledOnce();
      expect(writeCredentialsMock).toHaveBeenCalledOnce();
      expect(joinedOutput(stdout)).toContain("Welcome to Falcon");
    }));

  it("propagates failure (with no extra message) when the auto-triggered pairing fails", async () =>
    withStdinTTY(true, async () => {
      pairDeviceMock.mockResolvedValue({ ok: false, reason: "cancelled" });
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const result = await ensureLoggedIn(fakeLogger(), "/home/fake");

      expect(result).toEqual({ ok: false, message: "" });
    }));

  // auth-ux-overhaul-fix-plan.md Fix 3 / E2E-6.4: web-side revocation never deletes
  // `access.key`, so a stale-but-present credentials file must NOT short-circuit
  // `ensureLoggedIn` when the caller has already proved (via a real 401) that the token
  // is dead. `{ force: true }` is that proof, and re-pairing must clear the dead file
  // FIRST so a Ctrl-C mid-pairing can't leave the short-circuit re-triggering.
  it("re-pairs instead of short-circuiting when credentials exist but the caller passes force:true", async () =>
    withStdinTTY(true, async () => {
      readCredentialsMock.mockReturnValue({
        refreshToken: "stale-refresh-token",
        keyMaterial: { mode: "device", wrapped: {} },
      });
      const masterSecret = new Uint8Array(32).fill(2);
      pairDeviceMock.mockImplementation(
        async (options: { onPairingUrlReady: (u: string) => unknown }) => {
          await options.onPairingUrlReady("http://web.invalid/pair#frag");
          return { ok: true, result: { refreshToken: "refresh-token-2", masterSecret } };
        },
      );
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const result = await ensureLoggedIn(fakeLogger(), "/home/fake", { force: true });

      expect(result).toEqual({ ok: true });
      expect(clearCredentialsMock).toHaveBeenCalledWith("/home/fake");
      expect(pairDeviceMock).toHaveBeenCalledOnce();
      expect(writeCredentialsMock).toHaveBeenCalledOnce();
      // clearCredentials must run BEFORE pairing starts writing anything new.
      const clearOrder = clearCredentialsMock.mock.invocationCallOrder[0];
      const writeOrder = writeCredentialsMock.mock.invocationCallOrder[0];
      expect(clearOrder).toBeLessThan(writeOrder as number);
    }));
});
