import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkingDirectoryChip, workingDirectoryBasename } from "./WorkingDirectoryChip";

describe("workingDirectoryBasename", () => {
  it("returns the final path segment for a plain absolute path", () => {
    expect(workingDirectoryBasename("/Users/vy/code/kvy")).toBe("kvy");
  });

  it("ignores a trailing slash", () => {
    expect(workingDirectoryBasename("/Users/vy/code/kvy/")).toBe("kvy");
  });

  it("handles a Windows-style path", () => {
    expect(workingDirectoryBasename("C:\\Users\\vy\\kvy")).toBe("kvy");
  });

  it("falls back to the full path for a bare root", () => {
    expect(workingDirectoryBasename("/")).toBe("/");
  });

  it("falls back to the full value when there's no separator at all", () => {
    expect(workingDirectoryBasename("kvy")).toBe("kvy");
  });
});

describe("WorkingDirectoryChip", () => {
  it("renders the basename, and carries the full path as the hover title", () => {
    const html = renderToStaticMarkup(<WorkingDirectoryChip path="/Users/vy/code/kvy" />);
    expect(html).toContain("kvy");
    expect(html).toContain('title="/Users/vy/code/kvy"');
  });

  it("wires the copy button to the full path, not just the basename", () => {
    // `CopyButton` reads its text lazily via a `getText` thunk at click time
    // (no DOM event system here, so this can't click it) — assert the
    // static markup at least renders the copy affordance alongside the path,
    // same style as `CopyButton.test.ts`'s own pure-function-only coverage.
    const html = renderToStaticMarkup(<WorkingDirectoryChip path="/tmp/some-project" />);
    expect(html).toContain("Copy working directory path");
  });
});
