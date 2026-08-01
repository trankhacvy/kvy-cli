import { describe, expect, it } from "vitest";
import { ATTENTION_META } from "../attention.js";
import { computeTabTitle, faviconColor, faviconDataUri } from "../tab-attention.js";

describe("computeTabTitle", () => {
  it("prefixes with the attention glyph when attention is outstanding", () => {
    expect(computeTabTitle("My session", "perm", false)).toBe(
      `${ATTENTION_META.perm.glyph} My session · Kvy`,
    );
  });

  it("prefixes with a working marker when working and no attention", () => {
    expect(computeTabTitle("My session", null, true)).toBe("● My session · Kvy");
  });

  it("attention takes priority over working", () => {
    expect(computeTabTitle("My session", "done", true)).toBe(
      `${ATTENTION_META.done.glyph} My session · Kvy`,
    );
  });

  it("plain title when neither attention nor working", () => {
    expect(computeTabTitle("My session", null, false)).toBe("My session · Kvy");
  });
});

describe("faviconColor", () => {
  it("matches ATTENTION_META's color when attention is set", () => {
    expect(faviconColor("failed", false)).toBe(ATTENTION_META.failed.color);
  });

  it("uses a distinct working color when no attention but working", () => {
    const color = faviconColor(null, true);
    expect(color).not.toBe(ATTENTION_META.perm.color);
    expect(color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("uses a distinct idle color when neither attention nor working", () => {
    const idle = faviconColor(null, false);
    const working = faviconColor(null, true);
    expect(idle).not.toBe(working);
  });
});

describe("faviconDataUri", () => {
  it("produces an SVG data URI carrying the given color", () => {
    const uri = faviconDataUri("#ff0000");
    expect(uri).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(uri)).toContain("#ff0000");
  });
});
