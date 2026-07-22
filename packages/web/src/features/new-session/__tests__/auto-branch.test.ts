import { describe, expect, it } from "vitest";
import { generateBranchName } from "../auto-branch";

describe("generateBranchName", () => {
  it("matches the wf/<yyyyMMdd>-<4 chars> shape", () => {
    expect(generateBranchName()).toMatch(/^wf\/\d{8}-[a-z0-9]{4}$/);
  });

  it("uses the supplied date for the yyyyMMdd portion", () => {
    const name = generateBranchName(new Date(2026, 6, 22)); // July 22, 2026 (0-indexed month)
    expect(name.startsWith("wf/20260722-")).toBe(true);
  });

  it("two calls produce different suffixes", () => {
    const a = generateBranchName();
    const b = generateBranchName();
    expect(a).not.toBe(b);
  });

  it("contains no '..' path segment (gitWorktree.ts's assertSafeBranchName contract)", () => {
    const name = generateBranchName();
    expect(name.split("/").some((segment) => segment === "..")).toBe(false);
  });

  it("has no leading '-', no spaces, ASCII only (git check-ref-format contract)", () => {
    const name = generateBranchName();
    expect(name.startsWith("-")).toBe(false);
    expect(name).not.toMatch(/\s/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ASCII-only check
    expect(name).toMatch(/^[\x00-\x7F]+$/);
  });
});
