import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  detectSourceFromPath,
  findClaudeInPath,
  findGlobalClaudeCliPath,
  getVersion,
} from "./claudeCliLocator.js";

// Most of these cases are ported verbatim from Happy's
// claude_version_utils.test.ts (path-pattern detection has no I/O, so the
// assertions translate directly).
describe("detectSourceFromPath", () => {
  describe("npm installations", () => {
    it("detects npm global installation on macOS/Linux", () => {
      expect(
        detectSourceFromPath("/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
      ).toBe("npm");
    });

    it("detects npm global installation on Windows with forward slashes", () => {
      expect(
        detectSourceFromPath(
          "C:/Users/test/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js",
        ),
      ).toBe("npm");
    });

    it("detects npm global installation on Windows with backslashes", () => {
      expect(
        detectSourceFromPath(
          "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
        ),
      ).toBe("npm");
    });

    it("detects npm through Homebrew", () => {
      expect(
        detectSourceFromPath("/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
      ).toBe("npm");
    });

    it("does NOT detect a Homebrew cask as npm", () => {
      expect(
        detectSourceFromPath(
          "/opt/homebrew/lib/node_modules/@anthropic-ai/.claude-code-2DTsDk1V/cli.js",
        ),
      ).toBe("Homebrew");
    });
  });

  describe("Bun installations", () => {
    it("detects Bun global installation on Unix", () => {
      expect(detectSourceFromPath("/Users/test/.bun/bin/claude")).toBe("Bun");
    });

    it("detects Bun global installation on Windows", () => {
      expect(detectSourceFromPath("C:/Users/test/.bun/bin/claude")).toBe("Bun");
    });

    it("detects Bun in node_modules context", () => {
      expect(
        detectSourceFromPath(
          "/Users/test/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js",
        ),
      ).toBe("Bun");
    });
  });

  describe("Homebrew installations", () => {
    it("detects Homebrew on Apple Silicon macOS", () => {
      expect(detectSourceFromPath("/opt/homebrew/bin/claude")).toBe("Homebrew");
    });

    it("detects Homebrew on Linux", () => {
      expect(detectSourceFromPath("/home/linuxbrew/.linuxbrew/bin/claude")).toBe("Homebrew");
    });

    it("detects Homebrew user installation", () => {
      expect(detectSourceFromPath("/Users/test/.linuxbrew/bin/claude")).toBe("Homebrew");
    });

    it("detects Homebrew cask with a hashed directory", () => {
      expect(
        detectSourceFromPath(
          "/opt/homebrew/lib/node_modules/@anthropic-ai/.claude-code-2DTsDk1V/cli.js",
        ),
      ).toBe("Homebrew");
    });

    it("detects a Homebrew Cellar installation", () => {
      expect(detectSourceFromPath("/opt/homebrew/Cellar/claude-code/1.0.0/bin/claude")).toBe(
        "Homebrew",
      );
    });
  });

  describe("native installer installations", () => {
    it("detects native installer on Unix ~/.local", () => {
      expect(detectSourceFromPath("/Users/test/.local/bin/claude")).toBe("native installer");
    });

    it("detects native installer with versioned structure", () => {
      expect(detectSourceFromPath("/Users/test/.local/share/claude/versions/2.0.69/claude")).toBe(
        "native installer",
      );
    });

    it("detects native installer on Windows Program Files", () => {
      expect(detectSourceFromPath("C:/Program Files/Claude/claude.exe")).toBe("native installer");
    });

    it("detects native installer on Windows AppData", () => {
      expect(detectSourceFromPath("C:/Users/test/AppData/Local/Claude/claude.exe")).toBe(
        "native installer",
      );
    });

    it("detects native installer in user profile", () => {
      expect(detectSourceFromPath("C:/Users/test/.claude/claude.exe")).toBe("native installer");
    });
  });

  describe("edge cases", () => {
    it("handles @ symbols in paths correctly", () => {
      expect(
        detectSourceFromPath(
          "/Users/@developer/test/node_modules/@anthropic-ai/claude-code/cli.js",
        ),
      ).toBe("npm");
    });

    it("returns PATH for unrecognized paths", () => {
      expect(detectSourceFromPath("/some/random/path/claude")).toBe("PATH");
    });

    it("handles empty paths", () => {
      expect(detectSourceFromPath("")).toBe("PATH");
    });

    it("handles relative paths", () => {
      expect(detectSourceFromPath("./local/bin/claude")).toBe("PATH");
    });
  });

  describe("platform-specific /usr/local/bin/claude", () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    it("resolves to Homebrew on macOS", () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      expect(detectSourceFromPath("/usr/local/bin/claude")).toBe("Homebrew");
    });

    it("resolves to native installer on Linux", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      expect(detectSourceFromPath("/usr/local/bin/claude")).toBe("native installer");
    });

    it("falls back to PATH on Windows", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      expect(detectSourceFromPath("/usr/local/bin/claude")).toBe("PATH");
    });
  });
});

describe("compareVersions", () => {
  it("compares versions correctly", () => {
    expect(compareVersions("2.0.69", "2.0.68")).toBe(1);
    expect(compareVersions("2.0.68", "2.0.69")).toBe(-1);
    expect(compareVersions("2.0.69", "2.0.69")).toBe(0);
    expect(compareVersions("2.1.0", "2.0.69")).toBe(1);
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
  });

  it("handles malformed versions gracefully", () => {
    expect(() => compareVersions("", "2.0.0")).not.toThrow();
    expect(() => compareVersions("invalid", "2.0.0")).not.toThrow();
    expect(() => compareVersions("2.0.0", "")).not.toThrow();
  });
});

describe("getVersion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "falcon-cli-locator-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the version from an adjacent package.json when present", () => {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "2.1.99" }));
    const cliPath = path.join(dir, "cli.js");
    writeFileSync(cliPath, "// stub");
    expect(getVersion(cliPath)).toBe("2.1.99");
  });

  it("falls back to `--version` output for a binary with no adjacent package.json", () => {
    const cliPath = path.join(dir, "claude-stub");
    writeFileSync(cliPath, '#!/bin/sh\necho "2.1.177 (Claude Code)"\n');
    chmodSync(cliPath, 0o755);
    if (process.platform === "win32") return; // shebang scripts aren't directly executable on Windows
    expect(getVersion(cliPath)).toBe("2.1.177");
  });

  it("returns null when nothing resolves a version", () => {
    const cliPath = path.join(dir, "does-not-exist");
    expect(getVersion(cliPath)).toBeNull();
  });
});

describe("findClaudeInPath", () => {
  let root: string;
  const originalPath = process.env.PATH;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "falcon-cli-locator-path-"));
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });

  it("ignores broken npm native placeholder shims on non-Windows platforms", () => {
    if (process.platform === "win32") return;

    const binDir = path.join(root, "bin");
    const pkgBinDir = path.join(root, "node_modules", "@anthropic-ai", "claude-code", "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(pkgBinDir, { recursive: true });

    const placeholder = path.join(pkgBinDir, "claude.exe");
    writeFileSync(placeholder, 'echo "Error: claude native binary not installed." >&2\nexit 1\n');
    chmodSync(placeholder, 0o755);
    symlinkSync(placeholder, path.join(binDir, "claude"));

    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    expect(findClaudeInPath()).toBeNull();
  });

  it("resolves a real executable found on PATH", () => {
    if (process.platform === "win32") return;

    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const cliPath = path.join(binDir, "cli.js");
    writeFileSync(cliPath, "// stub");
    chmodSync(cliPath, 0o755); // `which` only reports executable matches
    symlinkSync(cliPath, path.join(binDir, "claude"));

    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    const result = findClaudeInPath();
    expect(result).not.toBeNull();
    expect(result?.path).toBe(realpathSync(cliPath));
  });

  it("resolves a real extensionless native binary found directly on PATH (>=2.1.113 format)", () => {
    if (process.platform === "win32") return;

    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    // Current @anthropic-ai/claude-code releases ship a platform-specific
    // native binary with no file extension on macOS/Linux (see
    // `resolveClaudeEntrypoint`'s doc comment) — this must not be mistaken
    // for an unresolvable Windows-style npm shim.
    const realBinary = path.join(binDir, "claude-real");
    writeFileSync(realBinary, "#!/bin/sh\necho stub\n");
    chmodSync(realBinary, 0o755);
    symlinkSync(realBinary, path.join(binDir, "claude"));

    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    const result = findClaudeInPath();
    expect(result).not.toBeNull();
    expect(result?.path).toBe(realpathSync(realBinary));
  });
});

describe("findGlobalClaudeCliPath", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "falcon-cli-locator-env-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses FALCON_CLAUDE_PATH when set and the path exists", () => {
    const cliPath = path.join(dir, "claude");
    writeFileSync(cliPath, "#!/bin/sh\necho mock\n");
    chmodSync(cliPath, 0o755);

    const result = findGlobalClaudeCliPath({ FALCON_CLAUDE_PATH: cliPath });
    expect(result?.source).toBe("FALCON_CLAUDE_PATH");
    expect(result?.path).toBe(realpathSync(cliPath));
  });

  it("ignores FALCON_CLAUDE_PATH when the path does not exist", () => {
    const result = findGlobalClaudeCliPath({ FALCON_CLAUDE_PATH: path.join(dir, "nonexistent") });
    expect(result?.source).not.toBe("FALCON_CLAUDE_PATH");
  });
});
