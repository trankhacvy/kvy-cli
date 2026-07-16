import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureBundleMtimeMs, hasBundleBeenReplaced } from "./selfUpdate.js";

describe("selfUpdate", () => {
  let dir: string;
  let bundlePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "falcon-self-update-"));
    bundlePath = path.join(dir, "index.mjs");
    await writeFile(bundlePath, "v1");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("captureBundleMtimeMs", () => {
    it("returns a number for an existing file", () => {
      expect(captureBundleMtimeMs(bundlePath)).toEqual(expect.any(Number));
    });

    it("returns null for a missing file (e.g. dev mode, no dist/ build)", () => {
      expect(captureBundleMtimeMs(path.join(dir, "does-not-exist.mjs"))).toBeNull();
    });
  });

  describe("hasBundleBeenReplaced", () => {
    it("is false immediately after capturing (nothing has changed)", () => {
      const initial = captureBundleMtimeMs(bundlePath);
      expect(hasBundleBeenReplaced(bundlePath, initial)).toBe(false);
    });

    it("is true once the file's mtime changes", async () => {
      const initial = captureBundleMtimeMs(bundlePath);
      // Bump mtime forward well past filesystem timestamp resolution rather
      // than relying on real wall-clock time passing during the test.
      const future = new Date(Date.now() + 60_000);
      await utimes(bundlePath, future, future);

      expect(hasBundleBeenReplaced(bundlePath, initial)).toBe(true);
    });

    it("is always false when detection is disabled (initialMtimeMs === null)", async () => {
      const future = new Date(Date.now() + 60_000);
      await utimes(bundlePath, future, future);

      expect(hasBundleBeenReplaced(bundlePath, null)).toBe(false);
    });

    it("is false when the file is transiently unreadable, never a false positive", () => {
      const initial = captureBundleMtimeMs(bundlePath);
      expect(hasBundleBeenReplaced(path.join(dir, "gone.mjs"), initial)).toBe(false);
    });
  });
});
