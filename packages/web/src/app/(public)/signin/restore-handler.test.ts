import { describe, expect, it, vi } from "vitest";
import type { CryptoBridgeClient } from "@/crypto";

const { restoreRecoveryCodeMock } = vi.hoisted(() => ({ restoreRecoveryCodeMock: vi.fn() }));

vi.mock("@/lib/restore-recovery-code", () => ({
  restoreRecoveryCode: (...args: unknown[]) => restoreRecoveryCodeMock(...args),
}));

const { handleRestoreFromRecoveryCode } = await import("./restore-handler.js");

function fakeBridge(): CryptoBridgeClient {
  const notImplemented = () => {
    throw new Error("not implemented in this fake");
  };
  return {
    init: notImplemented,
    setSessionKey: notImplemented,
    seal: notImplemented,
    open: notImplemented,
    sealBlob: notImplemented,
    openBlob: notImplemented,
    clear: notImplemented,
    getIdentity: notImplemented,
    signInChallenge: notImplemented,
    exportRecoveryCode: notImplemented,
    sealForPeer: notImplemented,
    terminate: () => {},
  };
}

describe("handleRestoreFromRecoveryCode", () => {
  it("sets restoring, then calls onSuccess with the next URL on an ok outcome (not the error setter)", async () => {
    restoreRecoveryCodeMock.mockResolvedValue({ kind: "ok", nextUrl: "/" });
    const setRestoreStatus = vi.fn();
    const onSuccess = vi.fn();

    await handleRestoreFromRecoveryCode(fakeBridge(), "SOME-CODE", { setRestoreStatus, onSuccess });

    expect(setRestoreStatus).toHaveBeenCalledWith({ kind: "restoring" });
    expect(setRestoreStatus).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith("/");
  });

  it("sets an error status (not onSuccess) for any non-ok outcome, surfacing that outcome's message", async () => {
    restoreRecoveryCodeMock.mockResolvedValue({
      kind: "no-account-found",
      message: "No account found for that recovery code.",
    });
    const setRestoreStatus = vi.fn();
    const onSuccess = vi.fn();

    await handleRestoreFromRecoveryCode(fakeBridge(), "SOME-CODE", { setRestoreStatus, onSuccess });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(setRestoreStatus).toHaveBeenLastCalledWith({
      kind: "error",
      message: "No account found for that recovery code.",
    });
  });

  it("reports the invalid-code message without ever calling onSuccess", async () => {
    restoreRecoveryCodeMock.mockResolvedValue({
      kind: "invalid-code",
      message: "That recovery code doesn't look right. Check it and try again.",
    });
    const setRestoreStatus = vi.fn();
    const onSuccess = vi.fn();

    await handleRestoreFromRecoveryCode(fakeBridge(), "garbage", { setRestoreStatus, onSuccess });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(setRestoreStatus).toHaveBeenLastCalledWith({
      kind: "error",
      message: "That recovery code doesn't look right. Check it and try again.",
    });
  });
});
