import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDirectory, FsBrowseError, listDirectory } from "./fsBrowse.js";

describe("listDirectory", () => {
  let root: string;

  beforeEach(async () => {
    // realpath'd up front: on macOS `mkdtemp` under `/tmp` resolves through a
    // `/private` symlink, and `listDirectory` always returns the resolved
    // path — comparisons below need the same resolved form as `root`.
    root = await realpath(await mkdtemp(path.join(tmpdir(), "falcon-fs-browse-")));
    await mkdir(path.join(root, "b-dir"));
    await mkdir(path.join(root, "a-dir"));
    await writeFile(path.join(root, "a-file.txt"), "hi");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists only directories, sorted alphabetically, and excludes files", async () => {
    const result = await listDirectory({ idempotencyKey: "idem-1", path: root });
    expect(result.entries).toEqual([
      { name: "a-dir", isDirectory: true },
      { name: "b-dir", isDirectory: true },
    ]);
  });

  it("resolves symlinks and reports the real path listed", async () => {
    const link = path.join(tmpdir(), `falcon-fs-browse-link-${Date.now()}`);
    await symlink(root, link);
    try {
      const result = await listDirectory({ idempotencyKey: "idem-2", path: link });
      expect(result.path).toBe(root);
    } finally {
      await rm(link, { force: true });
    }
  });

  it("reports the parent directory, and null at the filesystem root", async () => {
    const result = await listDirectory({ idempotencyKey: "idem-3", path: root });
    expect(result.parent).toBe(path.dirname(root));

    const rootResult = await listDirectory({ idempotencyKey: "idem-4", path: "/" });
    expect(rootResult.parent).toBeNull();
  });

  it("rejects a relative path", async () => {
    await expect(
      listDirectory({ idempotencyKey: "idem-5", path: "relative/path" }),
    ).rejects.toThrow(FsBrowseError);
  });

  it("throws when the directory doesn't exist", async () => {
    await expect(
      listDirectory({ idempotencyKey: "idem-6", path: path.join(root, "nope") }),
    ).rejects.toThrow(/not found/);
  });
});

describe("createDirectory", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "falcon-fs-mkdir-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a nested directory recursively", async () => {
    const target = path.join(root, "a", "b", "c");
    const result = await createDirectory({ idempotencyKey: "idem-1", path: target });
    expect(result).toEqual({ ok: true });

    const listed = await listDirectory({ idempotencyKey: "idem-2", path: path.join(root, "a") });
    expect(listed.entries).toEqual([{ name: "b", isDirectory: true }]);
  });

  it("is idempotent — creating an already-existing directory succeeds", async () => {
    const target = path.join(root, "again");
    await createDirectory({ idempotencyKey: "idem-3", path: target });
    await expect(createDirectory({ idempotencyKey: "idem-4", path: target })).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects a relative path", async () => {
    await expect(
      createDirectory({ idempotencyKey: "idem-5", path: "relative/path" }),
    ).rejects.toThrow(FsBrowseError);
  });
});
