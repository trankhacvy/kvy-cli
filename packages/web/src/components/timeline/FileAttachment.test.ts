import { describe, expect, it } from "vitest";
import type { FileItem } from "@/sync/reducer";
import { InlineImageAttachment, isInlineFileRef } from "./FileAttachment";

function fileItem(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: "1",
    time: 0,
    role: "agent",
    kind: "file",
    ref: "inline:aGVsbG8=",
    name: "image.png",
    size: 6,
    ...overrides,
  };
}

/** plan-v2.md W3.2 — web render coverage: `inline:` refs render as `<img
 * src="data:...">` directly, no download/decrypt round trip. `InlineImageAttachment`
 * is deliberately hook-free, so — mirroring `tool-cards/registry.test.ts`'s own
 * "call it directly, inspect the returned element" pattern — this needs no DOM/render
 * environment. */
describe("isInlineFileRef", () => {
  it("recognizes an inline: ref", () => {
    expect(isInlineFileRef("inline:aGVsbG8=")).toBe(true);
  });

  it("rejects a real blob-storage ref", () => {
    expect(isInlineFileRef("blob_abc123")).toBe(false);
  });
});

describe("InlineImageAttachment", () => {
  it("renders an <img> with a data: URI built from the base64 payload + a media type inferred from the file extension", () => {
    const element = InlineImageAttachment({
      item: fileItem({ ref: "inline:aGVsbG8=", name: "image.png" }),
    });
    expect(element.type).toBe("img");
    expect(element.props.src).toBe("data:image/png;base64,aGVsbG8=");
    expect(element.props.alt).toBe("image.png");
  });

  it("infers image/jpeg from a .jpg name", () => {
    const element = InlineImageAttachment({
      item: fileItem({ ref: "inline:Zm9v", name: "image.jpg" }),
    });
    expect(element.props.src).toBe("data:image/jpeg;base64,Zm9v");
  });

  it("falls back to image/png for an unrecognized extension", () => {
    const element = InlineImageAttachment({
      item: fileItem({ ref: "inline:Zm9v", name: "image.bin" }),
    });
    expect(element.props.src).toBe("data:image/png;base64,Zm9v");
  });

  // Mirrors envelopeMapper.ts's IMAGE_EXTENSION_BY_MEDIA_TYPE / imageFileName —
  // every extension the CLI can mint for an inline image must round-trip back
  // to the right MIME type here, or the browser renders the <img> as broken.
  it.each([
    ["image.gif", "image/gif"],
    ["image.webp", "image/webp"],
  ] as const)("infers %s -> %s", (name, expectedMime) => {
    const element = InlineImageAttachment({
      item: fileItem({ ref: "inline:Zm9v", name }),
    });
    expect(element.props.src).toBe(`data:${expectedMime};base64,Zm9v`);
  });
});
