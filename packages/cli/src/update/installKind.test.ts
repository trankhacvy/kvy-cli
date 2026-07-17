import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectInstallKind } from "./installKind.js";

describe("detectInstallKind", () => {
  let dir: string;
  let bundlePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "falcon-install-kind-"));
    bundlePath = path.join(dir, "index.mjs");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is standalone-binary when isCompiledBinary is true, regardless of bundlePath", () => {
    expect(detectInstallKind({ isCompiledBinary: true, bundlePath })).toBe("standalone-binary");
  });

  it("is npm when not a compiled binary and the bundle file exists", async () => {
    await writeFile(bundlePath, "export {}");
    expect(detectInstallKind({ isCompiledBinary: false, bundlePath })).toBe("npm");
  });

  it("is dev when not a compiled binary and the bundle file doesn't exist", () => {
    expect(detectInstallKind({ isCompiledBinary: false, bundlePath })).toBe("dev");
  });
});
