import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RemoveWorkspaceControl } from "./remove-workspace-control";

describe("RemoveWorkspaceControl", () => {
  it("shows only the remove trigger by default — the confirm dialog stays closed until clicked", () => {
    const html = renderToStaticMarkup(
      createElement(RemoveWorkspaceControl, { onRemove: vi.fn(), isPending: false, done: false }),
    );
    expect(html).toContain("Remove workspace");
    // The dialog (and its "nothing on disk changes" explanation) is closed
    // by default — this package has no click-simulation harness to open it,
    // so the dialog body itself isn't exercised by this smoke test.
    expect(html).not.toContain("nothing on disk changes");
  });

  it("shows a done confirmation instead of the trigger once removed", () => {
    const html = renderToStaticMarkup(
      createElement(RemoveWorkspaceControl, { onRemove: vi.fn(), isPending: false, done: true }),
    );
    expect(html).not.toContain("Remove workspace");
    expect(html).toContain("Removed.");
  });

  it("never calls onRemove merely by rendering", () => {
    const onRemove = vi.fn();
    renderToStaticMarkup(
      createElement(RemoveWorkspaceControl, { onRemove, isPending: false, done: false }),
    );
    expect(onRemove).not.toHaveBeenCalled();
  });
});
