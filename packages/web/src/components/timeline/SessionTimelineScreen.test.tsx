import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionRow } from "@kvy/wire";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isSessionControlDisabled, LifecycleBanner } from "./SessionTimelineScreen";

/**
 * Covers the actual UI wiring `status.test.ts` (features/session-list) can't
 * reach — that file only exercises the Home-screen status derivation, not
 * this screen's own ended/failed banner + disabled-controls rule
 * `isSessionControlDisabled` are pulled out of `SessionTimelineScreen.tsx`
 * as plain, hook-free exports specifically so this can render the real
 * production JSX via `react-dom/server`'s `renderToStaticMarkup` — no
 * jsdom/@testing-library needed, same style already used by
 * `lib/markdown.test.ts`.
 */

const STATUSES: SessionRow["status"][] = ["active", "archived", "compacted", "ended", "failed"];

describe("isSessionControlDisabled", () => {
  it("disables for the two terminal CLI-process-gone statuses plus archived", () => {
    const disabled = STATUSES.filter(isSessionControlDisabled);
    expect(disabled.sort()).toEqual(["archived", "ended", "failed"]);
  });
});

describe("LifecycleBanner", () => {
  it.each(["active", "compacted"] as const)(
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

  it("renders archived-specific copy, styled as a neutral (non-destructive) notice", () => {
    const html = renderToStaticMarkup(<LifecycleBanner sessionStatus="archived" />);
    expect(html).toContain("This session is archived");
    expect(html).toContain("worktree has been removed");
    expect(html).not.toContain("bg-destructive");
  });
});

describe("deriveWorking wiring (the stuck 'Working…' header)", () => {
  // `SessionTimelineScreen` itself can't be rendered here — it pulls in the
  // live sync engine, TanStack Query, and the session-scoped crypto worker
  // via non-hook-free hooks (`useLiveRenderItems`/`useSessionEphemerals`/
  // etc.), none of which are wired up in this vitest `environment: "node"`
  // setup (see the file header above and `vitest.config.ts`). So this
  // asserts against the component's own shipped source text instead — the
  // same "exercise what's actually in the file" spirit as
  // `push/__tests__/sw.test.ts` — rather than skipping the guard entirely.
  // This is the regression the fix-plan calls out by name: a stuck-`true`
  // `ephemeralWorking` must never be able to override an already-closed
  // turn again by `working` going back to the old
  // `ephemeralWorking || isTurnOpen(items)` inline form.
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./SessionTimelineScreen.tsx"),
    "utf8",
  );

  it("computes `working` by calling deriveWorking(items, ephemeralWorking) directly", () => {
    expect(source).toMatch(/\bconst working = deriveWorking\(items, ephemeralWorking\);/);
  });

  it("never reintroduces the old ephemeralWorking-OR-isTurnOpen inline form", () => {
    expect(source).not.toMatch(/ephemeralWorking\s*\|\|\s*isTurnOpen\(/);
  });
});
