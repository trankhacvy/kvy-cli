import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PermissionModePicker } from "./permission-mode-picker";

/**
 * Component/rendering tests (`react-dom/server`'s `renderToStaticMarkup` —
 * this package has no jsdom/`@testing-library/react`, same constraint
 * `GitToolbar.test.tsx` documents) for B6's one required fix carried into
 * the new-session-from-web redesign: `bypassPermissions` ("allow all") must
 * be visually distinguished from the other three permission-mode options,
 * not sit as a plain, undifferentiated dropdown row. The amber warning
 * banner this asserts on is a plain sibling `<div>` of the `Select` (not
 * inside its portal-based, closed-by-default dropdown content), so it's
 * directly assertable here even though the dropdown's own option rows
 * aren't (`new-session-panel.test.tsx`'s own note on that Radix constraint).
 */
describe("PermissionModePicker", () => {
  it("renders no warning banner for the default mode", () => {
    const html = renderToStaticMarkup(<PermissionModePicker value="default" onChange={() => {}} />);
    expect(html).not.toContain("Needs attention");
    expect(html).not.toContain("auto-approved");
  });

  it("renders no warning banner for acceptEdits", () => {
    const html = renderToStaticMarkup(
      <PermissionModePicker value="acceptEdits" onChange={() => {}} />,
    );
    expect(html).not.toContain("Needs attention");
  });

  it("renders no warning banner for plan", () => {
    const html = renderToStaticMarkup(<PermissionModePicker value="plan" onChange={() => {}} />);
    expect(html).not.toContain("Needs attention");
  });

  it("renders the amber 'Needs attention' warning banner once bypassPermissions is selected", () => {
    const html = renderToStaticMarkup(
      <PermissionModePicker value="bypassPermissions" onChange={() => {}} />,
    );
    expect(html).toContain("Needs attention");
    expect(html).toContain("auto-approved");
    expect(html).toContain("border-amber-500/40");
  });
});
