import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `PairPage` can't be rendered directly under this package's `environment: "node"` vitest
 * config (`next/navigation`'s `useRouter` + a real crypto worker) — same source-text
 * technique `app/(public)/signin/page.test.ts` uses for similarly hook-heavy JSX.
 */
const pageSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./page.tsx"),
  "utf-8",
);

describe("pair/page.tsx — gate order", () => {
  it("checks sign-in BEFORE key material", () => {
    const signInIndex = pageSource.indexOf("isSignedIn()");
    const identityIndex = pageSource.indexOf("bridge.getIdentity");
    expect(signInIndex).toBeGreaterThan(-1);
    if (identityIndex > -1) expect(signInIndex).toBeLessThan(identityIndex);
  });

  it("stashes the pending pairing before redirecting a signed-out visitor", () => {
    expect(pageSource).toContain("stashPendingPair(ephPub)");
    expect(pageSource).toContain("router.replace(SIGNIN_PATH)");
  });

  it("offers to fetch keys instead of dead-ending a browser that has none", () => {
    expect(pageSource).toContain("RequestKeysPanel");
    expect(pageSource).not.toContain("no Kvy key material");
  });

  it("renders the approve card's requester-supplied details as plain text", () => {
    expect(pageSource).toContain("fetchPairDetails");
    expect(pageSource).toContain("copy.pair.approveWarning");
    expect(pageSource).not.toContain("dangerouslySetInnerHTML");
  });

  it("converts the base64url fragment to plain base64 exactly once, via the helper", () => {
    expect(pageSource).toContain("parseEphPubFromHash");
    expect(pageSource).not.toContain('decodeBase64(ephPubUrlSafe, "base64url")');
  });

  it("has a success screen that sends the user back to the terminal", () => {
    expect(pageSource).toContain("copy.pair.doneBody");
  });
});

describe("pair/page.tsx — Approve button disabled state", () => {
  it("derives its disabled prop from bridgeStatus, not just a pending flag", () => {
    const buttonIndex = pageSource.indexOf("onClick={() => void approve(gate.ephPub");
    expect(buttonIndex).toBeGreaterThan(-1);
    const nearButton = pageSource.slice(Math.max(0, buttonIndex - 200), buttonIndex);
    expect(nearButton).toContain('disabled={bridgeStatus.kind !== "ready"}');
  });

  it("shows a preparing label instead of Approve while not ready", () => {
    expect(pageSource).toContain("copy.pair.preparingCta");
    expect(pageSource).toContain(
      'bridgeStatus.kind === "ready" ? copy.pair.approveCta : copy.pair.preparingCta',
    );
  });
});
