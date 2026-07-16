import { describe, expect, it } from "vitest";
import {
  CODEX_NOT_INSTALLED_MESSAGE,
  codexProvider,
  detectCodex,
  startLocal,
} from "./codexProviderAdapter.js";

describe("detectCodex", () => {
  it("reports installed+authenticated when the version check succeeds", async () => {
    const result = await detectCodex({ resolveVersion: () => "codex-cli 0.107.0" });
    expect(result).toEqual({ installed: true, authenticated: true, version: "codex-cli 0.107.0" });
  });

  it("reports not installed with an actionable error when the version check fails", async () => {
    const result = await detectCodex({ resolveVersion: () => null });
    expect(result).toEqual({
      installed: false,
      authenticated: false,
      error: CODEX_NOT_INSTALLED_MESSAGE,
    });
  });
});

describe("codexProvider.startLocal", () => {
  it("always returns null — Codex has no local TUI mode", () => {
    expect(startLocal({})).toBeNull();
    expect(codexProvider.startLocal({})).toBeNull();
  });

  it("exposes the 'codex' provider id", () => {
    expect(codexProvider.id).toBe("codex");
  });
});
