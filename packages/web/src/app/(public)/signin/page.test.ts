import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `page.tsx` can't be rendered directly under this package's `environment:
 * "node"` vitest config: it's a full page component using `next/navigation`'s
 * `useRouter` (throws outside an actual App Router context) plus the
 * `useCryptoBridge` worker-spinning hook, neither of which has a lightweight
 * fake here. Asserting against the shipped source text is the same technique
 * `SessionTimelineScreen.test.tsx` uses for similarly hook-heavy, non-pulled-out
 * JSX — real behavior (the restore submit handler, the outcome-to-status
 * mapping) is covered directly by `restore-handler.test.ts` and
 * `lib/restore-recovery-code.test.ts`; this just confirms the entry point is
 * actually wired into the page, in the right place, once.
 */
const pageSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./page.tsx"),
  "utf-8",
);

describe("signin/page.tsx — recovery-code restore wiring", () => {
  it("imports RecoveryCodeInput and the restore handler", () => {
    expect(pageSource).toContain(
      'import { RecoveryCodeInput } from "@/components/auth/recovery-code-input"',
    );
    expect(pageSource).toContain("handleRestoreFromRecoveryCode");
  });

  it("renders RecoveryCodeInput above (before) the Google/GitHub OAuth buttons", () => {
    const restoreIndex = pageSource.indexOf("<RecoveryCodeInput");
    const googleIndex = pageSource.indexOf("Continue with Google");
    const githubIndex = pageSource.indexOf("Continue with GitHub");

    expect(restoreIndex).toBeGreaterThan(-1);
    expect(googleIndex).toBeGreaterThan(-1);
    expect(githubIndex).toBeGreaterThan(-1);
    expect(restoreIndex).toBeLessThan(googleIndex);
    expect(restoreIndex).toBeLessThan(githubIndex);
  });

  it("only invokes the restore submit handler when a crypto bridge is available (no-op otherwise, not a crash)", () => {
    expect(pageSource).toMatch(
      /function handleRestoreSubmit\(code: string\) \{\s*if \(!bridge\) return;/,
    );
  });
});
