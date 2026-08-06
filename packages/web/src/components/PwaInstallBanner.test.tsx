import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// This package's vitest config runs `environment: "node"` with no jsdom/
// `@testing-library/react` wired up. `PwaInstallBanner` gates its whole
// render on a `mounted` flag that only flips true once its mount
// `useEffect` runs - a static-markup render never flushes effects, so every
// case here renders nothing, regardless of what `usePwaInstall` reports.
// That's deliberate (see the component's own comment on why `mounted`
// exists: `canInstall` can be synchronously `true` on first render while
// `dismissed`/`isIos` can't, and gating on `mounted` is what prevents a
// previously-dismissed user from seeing a one-frame flash). The actual mode
// selection logic is covered, without this constraint, by
// `getInstallBannerMode`'s own tests in `pwa-install-banner-state.test.ts`.
const install = vi.fn();
let pwaInstallState = { canInstall: false, isInstalled: false, install };
vi.mock("@/hooks/use-pwa-install", () => ({
  usePwaInstall: () => pwaInstallState,
}));

const { PwaInstallBanner } = await import("./PwaInstallBanner");

describe("PwaInstallBanner", () => {
  it("renders nothing before mount when nothing is installable", () => {
    pwaInstallState = { canInstall: false, isInstalled: false, install };
    expect(renderToStaticMarkup(createElement(PwaInstallBanner))).toBe("");
  });

  it("renders nothing before mount, even when a native prompt is already available", () => {
    pwaInstallState = { canInstall: true, isInstalled: false, install };
    expect(renderToStaticMarkup(createElement(PwaInstallBanner))).toBe("");
  });

  it("renders nothing before mount when already installed", () => {
    pwaInstallState = { canInstall: false, isInstalled: true, install };
    expect(renderToStaticMarkup(createElement(PwaInstallBanner))).toBe("");
  });

  it("never calls install() merely by rendering", () => {
    pwaInstallState = { canInstall: true, isInstalled: false, install };
    renderToStaticMarkup(createElement(PwaInstallBanner));
    expect(install).not.toHaveBeenCalled();
  });
});
