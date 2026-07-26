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

  it("only accepts google/github providers — the dev bypass is gone", () => {
    expect(source).toContain('provider: "google" | "github";');
    expect(source).not.toContain('"dev"');
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
    expect(source).toContain(
      "setStepUpReturn({ provider, oauthProof: proof.value, refreshToken })",
    );
  });

  it("never routes a raw refresh token or oauth proof through sessionStorage", () => {
    expect(codeOnlySource).not.toContain("sessionStorage");
  });

  it("wraps the step-up register() call so a network/API failure surfaces an error instead of hanging silently", () => {
    const stepUpBranch = source.slice(
      source.indexOf("consumePendingStepUp(provider)"),
      source.indexOf("const identity = await bridge.getIdentity()"),
    );
    const tryIndex = stepUpBranch.indexOf("try {");
    const registerIndex = stepUpBranch.indexOf("await register(");
    const catchIndex = stepUpBranch.indexOf("} catch (err) {");
    // Formatting-agnostic: the catch must SET an error status, however prettified.
    const statusIndex = stepUpBranch.replace(/\s+/g, " ").indexOf('setStatus({ kind: "error"');
    expect(tryIndex).toBeGreaterThan(-1);
    expect(registerIndex).toBeGreaterThan(tryIndex);
    expect(catchIndex).toBeGreaterThan(registerIndex);
    expect(statusIndex).toBeGreaterThan(-1);
  });
});

describe("oauth-callback-page.tsx — returning-user 409 (docs/auth-ux-overhaul-plan.md Phase 4/5)", () => {
  it("detects a keys/bind 409 and offers key sharing instead of a dead end", () => {
    const handlerIndex = source.indexOf("async function handleProtectionChoice");
    expect(handlerIndex).toBeGreaterThan(-1);
    const body = source.slice(handlerIndex);
    expect(body).toContain("err.status === 409");
    expect(body).toContain('kind: "needs-keys"');
  });

  // auth-ux-overhaul-fix-plan.md Fix 4 Part A2: the returning-browser effect's OWN catch
  // (not just handleProtectionChoice's) reaches `completeOAuthSignIn`, which now takes the
  // account-scoped `init` path whenever the effect's unscoped pre-check guessed "reuse" but
  // the scoped check found a foreign record — surfacing as keysBind's 409 here too. Before
  // this fix that 409 fell through to the generic "Sign-in failed" error.
  it("the returning-user effect's own catch ALSO handles a keys/bind 409, not just handleProtectionChoice's", () => {
    const effectIndex = source.indexOf("const identity = await bridge.getIdentity()");
    expect(effectIndex).toBeGreaterThan(-1);
    const effectBody = source.slice(effectIndex);
    const catchIndex = effectBody.indexOf("} catch (err) {");
    expect(catchIndex).toBeGreaterThan(-1);
    const catchBlock = effectBody.slice(catchIndex).replace(/\s+/g, " ");
    expect(catchBlock).toContain("err.status === 409");
    expect(catchBlock).toContain('kind: "needs-keys"');
  });

  it("renders the non-destructive recovery, with no destructive peer button", () => {
    expect(source).toContain("RequestKeysPanel");
    expect(source).not.toContain("Reset keys for this browser");
  });

  it("has no PIN steps left", () => {
    expect(source).not.toContain("PinSetupForm");
    expect(source).not.toContain("PinUnlockForm");
  });
});
