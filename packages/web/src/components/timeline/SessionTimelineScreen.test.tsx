import type { SessionRow } from "@falcon/wire";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isSessionControlDisabled, LifecycleBanner } from "./SessionTimelineScreen";

/**
 * Covers the actual UI wiring `status.test.ts` (features/session-list) can't
 * reach — that file only exercises the Home-screen status derivation, not
 * this screen's own ended/failed banner + disabled-controls rule
 * (plan-v2.md W1.4+B15, sub-task 4). `LifecycleBanner`/
 * `isSessionControlDisabled` are pulled out of `SessionTimelineScreen.tsx`
 * as plain, hook-free exports specifically so this can render the real
 * production JSX via `react-dom/server`'s `renderToStaticMarkup` — no
 * jsdom/@testing-library needed, same style already used by
 * `lib/markdown.test.ts`.
 */

const STATUSES: SessionRow["status"][] = ["active", "archived", "compacted", "ended", "failed"];

describe("isSessionControlDisabled", () => {
  it("disables only for the two terminal CLI-process-gone statuses", () => {
    const disabled = STATUSES.filter(isSessionControlDisabled);
    expect(disabled.sort()).toEqual(["ended", "failed"]);
  });
});

describe("LifecycleBanner", () => {
  it.each(["active", "archived", "compacted"] as const)(
    "renders nothing for a still-controllable session (%s)",
    (status) => {
      const html = renderToStaticMarkup(<LifecycleBanner sessionStatus={status} />);
      expect(html).toBe("");
    },
  );

  it("renders the ended banner copy, styled as a neutral (non-destructive) notice", () => {
    const html = renderToStaticMarkup(<LifecycleBanner sessionStatus="ended" />);
    expect(html).toContain("Session ended");
    expect(html).toContain("can no longer be controlled from the web");
    expect(html).not.toContain("bg-destructive");
  });

  it("renders the failed banner copy, styled as a destructive notice", () => {
    const html = renderToStaticMarkup(<LifecycleBanner sessionStatus="failed" />);
    expect(html).toContain("Session failed");
    expect(html).toContain("can no longer be controlled from the web");
    expect(html).toContain("bg-destructive");
  });
});
