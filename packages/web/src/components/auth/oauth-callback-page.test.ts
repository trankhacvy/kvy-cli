import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `OAuthCallbackPage` can't be exercised end-to-end under this package's `environment: "node"`
 * vitest config (`next/navigation`'s `useRouter`, a real crypto worker, and the OAuth round
 * trip itself all need a browser) — same source-text technique
 * `app/(public)/signin/page.test.ts` and `app/(protected)/layout.test.ts` use for similarly
 * hook-heavy, non-pulled-out JSX. `rotateKeyEpochOAuth`'s own behavior (item 8's "step-up
 * completes and calls keys/bind with stepUpProof.kind === 'oauth'") is unit-tested directly in
 * `lib/complete-password-sign-in.test.ts`; `consumePendingStepUp`'s confused-deputy guard is
 * unit-tested in `lib/__tests__/pending-stepup.test.ts`. This file locks the WIRING between
 * them inside the callback component.
 */
const source = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./oauth-callback-page.tsx"),
  "utf-8",
);

/**
 * A doc comment above the step-up branch deliberately names `sessionStorage` when
 * explaining what the refresh token/proof must NOT go through (security review finding
 * F1) — that mention would otherwise false-positive the "never routes ... through
 * sessionStorage" assertion below. Strip comments so it checks the actual code.
 */
const codeOnlySource = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("oauth-callback-page.tsx — step-up branch (docs/auth-ux-hardening-plan.md item 2c)", () => {
  it("consumes (not peeks) the pending step-up flag, validating the provider matches", () => {
    expect(source).toContain("consumePendingStepUp(provider)");
  });

  it("only checks for a step-up on google/github — dev never stashes one", () => {
    const guardIndex = source.indexOf('if (provider === "google" || provider === "github")');
    const consumeIndex = source.indexOf("consumePendingStepUp(provider)");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(consumeIndex).toBeGreaterThan(guardIndex);
  });

  it("completes sign-in (register + setToken) before handing off, so a fresh refresh token exists", () => {
    const stepUpBranch = source.slice(source.indexOf("consumePendingStepUp(provider)"));
    const registerIndex = stepUpBranch.indexOf("await register(");
    const setTokenIndex = stepUpBranch.indexOf("setToken(token)");
    const setReturnIndex = stepUpBranch.indexOf("setStepUpReturn(");
    const redirectIndex = stepUpBranch.indexOf('router.replace("/reset-keys/")');
    expect(registerIndex).toBeGreaterThan(-1);
    expect(setTokenIndex).toBeGreaterThan(registerIndex);
    expect(setReturnIndex).toBeGreaterThan(setTokenIndex);
    expect(redirectIndex).toBeGreaterThan(setReturnIndex);
  });

  it("carries {provider, oauthProof, refreshToken} to /reset-keys/ via setStepUpReturn, not sessionStorage", () => {
    expect(source).toContain("setStepUpReturn({ provider, oauthProof: proof.value, refreshToken })");
  });

  it("never routes a raw refresh token or oauth proof through sessionStorage", () => {
    expect(codeOnlySource).not.toContain("sessionStorage");
  });
});

describe("oauth-callback-page.tsx — returning-user 409 (docs/auth-ux-hardening-plan.md item 2c/6)", () => {
  it("detects a keys/bind 409 in the set-pin branch and offers recovery instead of a dead end", () => {
    const handlePinSetupIndex = source.indexOf("async function handlePinSetup");
    const handleUnlockIndex = source.indexOf("async function handleUnlock");
    expect(handlePinSetupIndex).toBeGreaterThan(-1);
    expect(handleUnlockIndex).toBeGreaterThan(handlePinSetupIndex);
    const handlePinSetupBody = source.slice(handlePinSetupIndex, handleUnlockIndex);
    expect(handlePinSetupBody).toContain('err.status === 409');
    expect(handlePinSetupBody).toContain('kind: "already-bound"');
  });

  it("offers Pair (primary) before Reset (secondary) on the already-bound screen", () => {
    const alreadyBoundIndex = source.indexOf('status.kind === "already-bound"');
    const unlockIndex = source.indexOf('status.kind === "unlock"');
    expect(alreadyBoundIndex).toBeGreaterThan(-1);
    expect(unlockIndex).toBeGreaterThan(alreadyBoundIndex);
    const block = source.slice(alreadyBoundIndex, unlockIndex);
    const pairIndex = block.indexOf("Pair from another device");
    const resetIndex = block.indexOf("Reset keys for this browser");
    expect(pairIndex).toBeGreaterThan(-1);
    expect(resetIndex).toBeGreaterThan(pairIndex);
  });
});
