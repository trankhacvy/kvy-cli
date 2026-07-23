import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `page.tsx` can't be rendered directly under this package's `environment:
 * "node"` vitest config: it's a full page component using `next/navigation`'s
 * `useRouter` (throws outside an actual App Router context), neither of which
 * has a lightweight fake here. Asserting against the shipped source text is
 * the same technique `SessionTimelineScreen.test.tsx` uses for similarly
 * hook-heavy, non-pulled-out JSX.
 *
 * issue-4-plan.md §5.5/Phase 4: the legacy challenge-sign-in + recovery-code
 * restore paths are gone from this page — it's OAuth buttons plus a link to
 * `/password/`, nothing that reads local key material before a login click.
 */
const pageSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./page.tsx"),
  "utf-8",
);

describe("signin/page.tsx", () => {
  it("no longer references the deleted recovery-code / challenge-sign-in modules", () => {
    expect(pageSource).not.toContain("recovery-code-input");
    expect(pageSource).not.toContain("RecoveryCodeInput");
    expect(pageSource).not.toContain("complete-challenge-sign-in");
    expect(pageSource).not.toContain("restore-handler");
    expect(pageSource).not.toContain("completeChallengeSignIn");
  });

  it("offers Google/GitHub OAuth and links to the email+password page", () => {
    expect(pageSource).toContain("Continue with Google");
    expect(pageSource).toContain("Continue with GitHub");
    expect(pageSource).toContain('router.push("/password/")');
  });
});
