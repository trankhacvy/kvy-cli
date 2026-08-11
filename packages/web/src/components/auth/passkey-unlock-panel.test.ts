import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source-text technique: `PasskeyUnlockPanel` can't render under `environment: "node"` vitest
// config (no DOM). These tests lock the wiring and copy invariants.
const source = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./passkey-unlock-panel.tsx"),
  "utf-8",
);

describe("passkey-unlock-panel.tsx", () => {
  it("calls discoverPasskey with accountId to find the user's synced passkey", () => {
    expect(source).toContain("discoverPasskey(accountId)");
  });

  it("calls bridge.claimPasskey after a successful discover", () => {
    expect(source).toContain(
      "bridge.claimPasskey(accountId, result.masterSecret, result.credentialId)",
    );
  });

  it("calls keysChallenge + keysBind to verify the derived keys match the server", () => {
    expect(source).toContain("keysChallenge(token)");
    expect(source).toContain("keysBind(token");
  });

  it("calls bridge.clear() on keysBind failure to remove the wrongly-claimed record", () => {
    const catchBlock = source.slice(source.indexOf("} catch {"), source.indexOf("} catch {") + 200);
    expect(catchBlock).toContain("bridge.clear()");
    expect(catchBlock).toContain('setState("error")');
  });

  it("calls onFallback when the 'Use another device instead' button is clicked", () => {
    expect(source).toContain("onFallback");
    const fallbackButtonIndex = source.indexOf("Use another device instead");
    expect(fallbackButtonIndex).toBeGreaterThan(-1);
    const surroundingCode = source.slice(
      Math.max(0, fallbackButtonIndex - 100),
      fallbackButtonIndex + 50,
    );
    expect(surroundingCode).toContain("onFallback");
  });

  it("shows an error state with a link to onFallback when passkey is not found", () => {
    expect(source).toContain('setState("error")');
    const errorBlock = source.slice(source.indexOf('state === "error"'));
    expect(errorBlock).toContain("onFallback");
  });

  it("calls onReady() on full success", () => {
    expect(source).toContain("onReady()");
  });

  it("disables the unlock button while working", () => {
    expect(source).toContain('state === "working"');
    const workingIndex = source.indexOf('"Unlocking...');
    expect(workingIndex).toBeGreaterThan(-1);
  });

  it("uses no internal jargon in visible copy", () => {
    const banned = [
      "masterSecret",
      "keyEpoch",
      "epoch",
      "DEK",
      "custody",
      "bridge",
      "ephPub",
      "claimPasskey",
      "credentialId",
    ];
    const jsxText = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/{[^}]*}/g, "");
    for (const word of banned) {
      expect(jsxText, `"${word}" must not appear in visible JSX text`).not.toContain(`>${word}`);
    }
  });
});
