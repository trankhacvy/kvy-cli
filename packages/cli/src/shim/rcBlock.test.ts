import { describe, expect, it } from "vitest";
import { buildRcBlock, hasRcBlock, insertRcBlock, removeRcBlock } from "./rcBlock.js";

describe("buildRcBlock", () => {
  it("uses POSIX export syntax", () => {
    const block = buildRcBlock("posix");
    expect(block).toContain("# >>> falcon shell shim >>>");
    expect(block).toContain('export PATH="$HOME/.falcon/bin:$PATH"');
    expect(block).toContain("# <<< falcon shell shim <<<");
  });

  it("uses fish set -gx syntax", () => {
    const block = buildRcBlock("fish");
    expect(block).toContain('set -gx PATH "$HOME/.falcon/bin" $PATH');
  });
});

describe("hasRcBlock", () => {
  it("detects the start marker", () => {
    expect(hasRcBlock(buildRcBlock("posix"))).toBe(true);
    expect(hasRcBlock("export PATH=/usr/bin")).toBe(false);
  });
});

describe("insertRcBlock", () => {
  it("appends the block to empty content with no leading blank line", () => {
    const result = insertRcBlock("", "posix");
    expect(result.startsWith("# >>> falcon shell shim >>>")).toBe(true);
    expect(result.endsWith("\n")).toBe(true);
  });

  it("appends after existing content, separated by exactly one blank line", () => {
    const result = insertRcBlock("export FOO=bar\n", "posix");
    expect(result).toBe(
      'export FOO=bar\n\n# >>> falcon shell shim >>>\nexport PATH="$HOME/.falcon/bin:$PATH"\n# <<< falcon shell shim <<<\n',
    );
  });

  it("is idempotent — returns content unchanged if the block is already present", () => {
    const once = insertRcBlock("export FOO=bar\n", "posix");
    const twice = insertRcBlock(once, "posix");
    expect(twice).toBe(once);
  });

  it("handles content with no trailing newline", () => {
    const result = insertRcBlock("export FOO=bar", "posix");
    expect(result).toBe(
      'export FOO=bar\n\n# >>> falcon shell shim >>>\nexport PATH="$HOME/.falcon/bin:$PATH"\n# <<< falcon shell shim <<<\n',
    );
  });
});

describe("removeRcBlock", () => {
  it("removes the block and the blank line before it", () => {
    const withBlock = insertRcBlock("export FOO=bar\n", "posix");
    expect(removeRcBlock(withBlock)).toBe("export FOO=bar\n");
  });

  it("removes a block that is the only content, leaving an empty string", () => {
    const withBlock = insertRcBlock("", "posix");
    expect(removeRcBlock(withBlock)).toBe("");
  });

  it("is idempotent — returns content unchanged if there's no block", () => {
    expect(removeRcBlock("export FOO=bar\n")).toBe("export FOO=bar\n");
  });

  it("round-trips: insert then remove restores the original content exactly", () => {
    const original = "# my rc file\nexport FOO=bar\nalias ll='ls -la'\n";
    const inserted = insertRcBlock(original, "posix");
    expect(removeRcBlock(inserted)).toBe(original);
  });

  it("leaves content untouched if the end marker is missing (malformed block)", () => {
    const malformed = "before\n# >>> falcon shell shim >>>\nexport PATH=x\nafter";
    expect(removeRcBlock(malformed)).toBe(malformed);
  });
});
