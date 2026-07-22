import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsReadError, readFile } from "./fsRead.js";

describe("readFile", () => {
  let root: string;

  beforeEach(async () => {
    // realpath'd up front: on macOS `mkdtemp` under `/tmp` resolves through a
    // `/private` symlink, and `readFile`'s containment check always compares
    // against the resolved worktree — see `fsBrowse.test.ts`'s own note.
    root = await realpath(await mkdtemp(path.join(tmpdir(), "falcon-fs-read-")));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads a text file's full content", async () => {
    const result = await readFile({
      idempotencyKey: "idem-1",
      worktree: root,
      path: "src/a.ts",
    });
    expect(result).toEqual({ inline: "export const a = 1;\n", truncated: false });
  });

  it("rejects an absolute path", async () => {
    await expect(
      readFile({ idempotencyKey: "idem-2", worktree: root, path: "/etc/passwd" }),
    ).rejects.toThrow(FsReadError);
  });

  it("rejects a path that traverses outside the worktree", async () => {
    await expect(
      readFile({ idempotencyKey: "idem-3", worktree: root, path: "../outside.txt" }),
    ).rejects.toThrow(/escapes the worktree/);
  });

  it("rejects a symlink inside the worktree pointing outside it", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "falcon-fs-read-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "top secret");
    const link = path.join(root, "escape-link");
    try {
      await symlink(path.join(outside, "secret.txt"), link);
      await expect(
        readFile({ idempotencyKey: "idem-4", worktree: root, path: "escape-link" }),
      ).rejects.toThrow(/escapes the worktree/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("throws for a missing file", async () => {
    await expect(
      readFile({ idempotencyKey: "idem-5", worktree: root, path: "nope.ts" }),
    ).rejects.toThrow(/not found/);
  });

  it("throws when the path is a directory", async () => {
    await expect(
      readFile({ idempotencyKey: "idem-6", worktree: root, path: "src" }),
    ).rejects.toThrow(/is a directory/);
  });

  it("throws for a binary file instead of returning garbled text", async () => {
    await expect(
      readFile({ idempotencyKey: "idem-7", worktree: root, path: "binary.bin" }),
    ).rejects.toThrow(/binary/);
  });

  it("truncates a file exceeding the inline byte budget and sets truncated: true", async () => {
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    await writeFile(path.join(root, "big.txt"), big);

    const result = await readFile(
      { idempotencyKey: "idem-8", worktree: root, path: "big.txt" },
      { maxInlineBytes: 50 },
    );

    expect(result.truncated).toBe(true);
    expect(result.inline).toBeDefined();
    expect(Buffer.byteLength(result.inline as string, "utf8")).toBeLessThanOrEqual(120);
    expect(result.inline).toContain("truncated");
    expect(result.blobRef).toBeUndefined();
  });

  it("uploads the full untruncated file as a blob and sets blobRef when truncated", async () => {
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    await writeFile(path.join(root, "big.txt"), big);
    const uploadBlob = async (plaintext: Uint8Array) => {
      expect(new TextDecoder().decode(plaintext)).toBe(big);
      return "blob-123";
    };

    const result = await readFile(
      { idempotencyKey: "idem-9", worktree: root, path: "big.txt" },
      { maxInlineBytes: 50, uploadBlob },
    );

    expect(result.truncated).toBe(true);
    expect(result.blobRef).toBe("blob-123");
  });

  it("does not truncate a file within the inline byte budget", async () => {
    const result = await readFile({ idempotencyKey: "idem-10", worktree: root, path: "src/a.ts" });
    expect(result.truncated).toBe(false);
  });

  it("honors an explicit byte range and marks the result truncated", async () => {
    await writeFile(path.join(root, "range.txt"), "0123456789");
    const result = await readFile({
      idempotencyKey: "idem-11",
      worktree: root,
      path: "range.txt",
      range: { start: 2, end: 5 },
    });
    expect(result).toEqual({ inline: "234", truncated: true });
  });

  it("marks a range covering the whole file as not truncated", async () => {
    await writeFile(path.join(root, "range2.txt"), "hello");
    const result = await readFile({
      idempotencyKey: "idem-12",
      worktree: root,
      path: "range2.txt",
      range: { start: 0, end: 5 },
    });
    expect(result).toEqual({ inline: "hello", truncated: false });
  });
});
