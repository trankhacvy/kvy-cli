import { describe, expect, it } from "vitest";
import { appendPage, EMPTY_PAGED_CONTENT, stripTruncationMarker } from "./file-content-paging";

describe("stripTruncationMarker", () => {
  it("removes fsRead.ts's inline truncation marker from the end of the text", () => {
    const text = "line one\nline two\n\n… (file truncated at 60000 bytes)\n";
    expect(stripTruncationMarker(text)).toBe("line one\nline two");
  });

  it("is a no-op for text without the marker", () => {
    expect(stripTruncationMarker("line one\nline two\n")).toBe("line one\nline two\n");
  });

  it("only strips the marker at the very end, not an occurrence mid-file", () => {
    const text = "some text mentioning … (file truncated at 5 bytes)\nmore content\n";
    expect(stripTruncationMarker(text)).toBe(text);
  });
});

describe("appendPage", () => {
  it("starts from EMPTY_PAGED_CONTENT for the first page", () => {
    const result = appendPage(null, { inline: "hello", truncated: false });
    expect(result).toEqual({ content: "hello", loadedBytes: 5, canLoadMore: false });
  });

  it("advances loadedBytes by the received page's UTF-8 byte length", () => {
    const first = appendPage(EMPTY_PAGED_CONTENT, { inline: "abc", truncated: true });
    expect(first).toEqual({ content: "abc", loadedBytes: 3, canLoadMore: true });

    const second = appendPage(first, { inline: "def", truncated: false });
    expect(second).toEqual({ content: "abcdef", loadedBytes: 6, canLoadMore: false });
  });

  it("counts multi-byte UTF-8 characters by their real byte length, not character count", () => {
    // "é" is 2 bytes in UTF-8.
    const result = appendPage(null, { inline: "café", truncated: false });
    expect(result.loadedBytes).toBe(5);
  });

  it("strips the truncation marker from the accumulated content but still counts the real content's bytes", () => {
    const page = { inline: "abc\n\n… (file truncated at 60000 bytes)\n", truncated: true };
    const result = appendPage(null, page);
    expect(result.content).toBe("abc");
    expect(result.loadedBytes).toBe(3);
    expect(result.canLoadMore).toBe(true);
  });

  it("a page with truncated:false clears canLoadMore even after a prior truncated page", () => {
    const first = appendPage(null, { inline: "a".repeat(10), truncated: true });
    const second = appendPage(first, { inline: "tail", truncated: false });
    expect(second.canLoadMore).toBe(false);
  });

  it("treats an undefined inline as an empty page (blobRef-only response)", () => {
    const result = appendPage(null, { inline: undefined, truncated: false });
    expect(result).toEqual({ content: "", loadedBytes: 0, canLoadMore: false });
  });
});
