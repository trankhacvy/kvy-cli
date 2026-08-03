import { execFileSync, execSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Locates the globally-installed Claude Code CLI across every install
 * method (npm, Homebrew, native installer, PATH fallback).
 *
 * `KVY_CLAUDE_PATH` is an env var override checked first, ahead of any
 * install-method detection. `runClaudeCli`/`getClaudeCliPath` (which spawn
 * the CLI and print install instructions to the terminal) are intentionally
 * omitted here — that belongs to the local-mode launcher (a separate,
 * not-yet-built concern) and never runs it or writes to stdout/stderr (see
 * `logger.ts`'s file-only-logging rule, which the same reasoning extends to
 * here). The `/goal` Stop-hook JSON-validation version warning has no Kvy
 * equivalent and was dropped rather than kept unused.
 *
 * Supports:
 * 1. npm global: `npm install -g @anthropic-ai/claude-code`
 * 2. Homebrew: `brew install claude-code`
 * 3. Native installer:
 *    - macOS/Linux: `curl -fsSL https://claude.ai/install.sh | bash`
 *    - PowerShell:  `irm https://claude.ai/install.ps1 | iex`
 *    - Windows CMD: `curl -fsSL https://claude.ai/install.cmd | cmd`
 * 4. PATH fallback: bun, pnpm, or any other package manager
 */

export type ClaudeInstallSource =
  | "KVY_CLAUDE_PATH"
  | "PATH"
  | "npm"
  | "Bun"
  | "Homebrew"
  | "native installer";

export interface ClaudeCliLocation {
  path: string;
  source: ClaudeInstallSource;
}

/** Safely resolve a symlink, falling back to the original path if resolution fails. */
function resolvePathSafe(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return realpathSync(filePath);
  } catch {
    // Symlink resolution failed, return original path
    return filePath;
  }
}

/**
 * Resolve the Claude Code entrypoint inside a package directory.
 *
 * Prior to `@anthropic-ai/claude-code@2.1.113` the package shipped a JS
 * entrypoint (`cli.js`) at the root. Starting with 2.1.113 the package ships
 * a platform-specific native binary declared in `package.json` `bin` (e.g.
 * `bin/claude.exe` on Windows, `bin/claude` elsewhere) and no longer
 * contains `cli.js`.
 */
function resolveClaudeEntrypoint(pkgDir: string): string | null {
  // Legacy: cli.js at package root (< 2.1.113)
  const legacyCliPath = path.join(pkgDir, "cli.js");
  if (existsSync(legacyCliPath)) return legacyCliPath;

  // Current: native binary declared via package.json "bin" (>= 2.1.113)
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.claude;
    if (!binRel) return null;
    const binPath = path.join(pkgDir, binRel);
    if (existsSync(binPath)) return binPath;
  } catch {
    // Malformed package.json — treat as not found
  }
  return null;
}

function isPlainTextWithoutShebang(filePath: string): boolean {
  try {
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(128);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      if (bytesRead >= 2 && buffer[0] === 0x23 && buffer[1] === 0x21) return false;
      for (let i = 0; i < bytesRead; i++) {
        const byte = buffer[i] as number;
        const isPrintableAscii = byte >= 0x20 && byte <= 0x7e;
        const isCommonWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
        if (!isPrintableAscii && !isCommonWhitespace) return false;
      }
      return bytesRead > 0;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Find path to npm globally installed Claude Code CLI. */
export function findNpmGlobalCliPath(): string | null {
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    const pkgDir = path.join(globalRoot, "@anthropic-ai", "claude-code");
    return resolveClaudeEntrypoint(pkgDir);
  } catch {
    // npm root -g failed
  }
  return null;
}

/**
 * Find Claude CLI using the system PATH (`which`/`where`). Respects the
 * user's own shell configuration and works across all platforms.
 */
export function findClaudeInPath(): ClaudeCliLocation | null {
  try {
    const command = process.platform === "win32" ? "where claude" : "which claude";
    const result = execSync(command, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

    const claudePath = result.split("\n")[0]?.trim();
    if (!claudePath) return null;

    // Check existence BEFORE resolving.
    if (!existsSync(claudePath)) return null;

    const resolvedPath = resolvePathSafe(claudePath) ?? claudePath;

    // On Windows, npm creates shell script shims (no extension) for global
    // packages. These cannot be spawned directly by Node.js. When we find
    // such a shim, resolve to the actual cli.js in the adjacent
    // node_modules directory. On other platforms `which`/`realpath` only
    // ever return real, already-executable files — including the
    // extensionless native binary `@anthropic-ai/claude-code` ships since
    // 2.1.113 (see `resolveClaudeEntrypoint`) — so no shim resolution is
    // needed there; treat any resolved path as executable.
    const isExecutable =
      process.platform !== "win32" ||
      resolvedPath.endsWith(".js") ||
      resolvedPath.endsWith(".cjs") ||
      resolvedPath.endsWith(".exe");
    if (
      process.platform !== "win32" &&
      resolvedPath.endsWith(".exe") &&
      isPlainTextWithoutShebang(resolvedPath)
    ) {
      return null;
    }
    if (!isExecutable) {
      const shimDir = path.dirname(claudePath);
      const pkgDir = path.join(shimDir, "node_modules", "@anthropic-ai", "claude-code");
      const entrypoint = resolveClaudeEntrypoint(pkgDir);
      if (entrypoint) return { path: entrypoint, source: "npm" };
      // Shim found but no resolvable entrypoint — skip and let other finders handle it
      return null;
    }

    // Detect source from BOTH original PATH entry and resolved path.
    // Original path tells us HOW the user accessed it (context); resolved
    // path tells us WHERE it actually lives (content). Prioritize original
    // for context (e.g. bun vs npm access), fall back to resolved.
    const originalSource = detectSourceFromPath(claudePath);
    const resolvedSource = detectSourceFromPath(resolvedPath);
    const source = originalSource !== "PATH" ? originalSource : resolvedSource;

    return { path: resolvedPath, source };
  } catch {
    // Command failed (claude not in PATH)
  }
  return null;
}

/** Detect installation source from a resolved path, using concrete path patterns only. */
export function detectSourceFromPath(resolvedPath: string): ClaudeInstallSource {
  const normalizedPath = path.normalize(resolvedPath).toLowerCase();

  // Bun: ~/.bun/bin/claude -> ../node_modules/@anthropic-ai/claude-code/cli.js
  if (
    (normalizedPath.includes(".bun") && normalizedPath.includes("bin")) ||
    (normalizedPath.includes("node_modules") && normalizedPath.includes(".bun"))
  ) {
    return "Bun";
  }

  // Homebrew cask: hashed directories like .claude-code-2DTsDk1V (NOT npm
  // installations). Must check before general Homebrew paths to distinguish
  // from npm-through-Homebrew.
  if (normalizedPath.includes("@anthropic-ai") && normalizedPath.includes(".claude-code-")) {
    return "Homebrew";
  }

  // npm: clean claude-code directory (even through Homebrew's npm).
  if (
    normalizedPath.includes("node_modules") &&
    normalizedPath.includes("@anthropic-ai") &&
    normalizedPath.includes("claude-code") &&
    !normalizedPath.includes(".claude-code-")
  ) {
    return "npm";
  }

  // Windows-specific detection (by path pattern, not current platform).
  if (
    normalizedPath.includes("appdata") ||
    normalizedPath.includes("program files") ||
    normalizedPath.endsWith(".exe")
  ) {
    if (
      normalizedPath.includes("appdata") &&
      normalizedPath.includes("npm") &&
      normalizedPath.includes("node_modules")
    ) {
      return "npm";
    }
    if (normalizedPath.endsWith("claude.exe")) return "native installer";
    if (normalizedPath.includes("appdata") && normalizedPath.includes("claude"))
      return "native installer";
    if (normalizedPath.includes("program files") && normalizedPath.includes("claude"))
      return "native installer";
  }

  // Homebrew general paths (non-npm installations like Cellar binaries).
  if (
    normalizedPath.includes("opt/homebrew") ||
    normalizedPath.includes("usr/local/homebrew") ||
    normalizedPath.includes("home/linuxbrew") ||
    normalizedPath.includes(".linuxbrew") ||
    normalizedPath.includes(".homebrew") ||
    normalizedPath.includes("cellar") ||
    normalizedPath.includes("caskroom") ||
    (normalizedPath.includes("usr/local/bin/claude") && process.platform === "darwin")
  ) {
    return "Homebrew";
  }

  // Native installer: standard Unix locations and ~/.local/bin.
  if (
    (normalizedPath.includes(".local") && normalizedPath.includes("bin")) ||
    (normalizedPath.includes(".local") &&
      normalizedPath.includes("share") &&
      normalizedPath.includes("claude")) ||
    (normalizedPath.includes("usr/local/bin/claude") && process.platform === "linux")
  ) {
    return "native installer";
  }

  // Default: found in PATH but can't determine source.
  return "PATH";
}

/** Find path to Bun globally installed Claude Code CLI. */
export function findBunGlobalCliPath(): string | null {
  try {
    const bunCheckCommand = process.platform === "win32" ? "where bun" : "which bun";
    execSync(bunCheckCommand, { encoding: "utf8" });
  } catch {
    return null; // bun not installed
  }

  const bunBin = path.join(homedir(), ".bun", "bin", "claude");
  const resolved = resolvePathSafe(bunBin);
  if (resolved?.endsWith("cli.js") && existsSync(resolved)) return resolved;
  return null;
}

/** Find path to Homebrew-installed Claude Code CLI. */
export function findHomebrewCliPath(): string | null {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;

  const possiblePrefixes = [
    "/opt/homebrew",
    "/usr/local",
    path.join(homedir(), ".linuxbrew"),
    path.join(homedir(), ".homebrew"),
  ].filter(existsSync);

  for (const prefix of possiblePrefixes) {
    // Check for binary symlink first (most reliable).
    const binPath = path.join(prefix, "bin", "claude");
    const resolved = resolvePathSafe(binPath);
    if (resolved && existsSync(resolved)) return resolved;

    // Fallback: check for hashed directories in node_modules.
    const nodeModulesPath = path.join(prefix, "lib", "node_modules", "@anthropic-ai");
    if (existsSync(nodeModulesPath)) {
      const entries = readdirSync(nodeModulesPath);
      for (const entry of entries) {
        if (entry === "claude-code" || entry.startsWith(".claude-code-")) {
          const cliPath = path.join(nodeModulesPath, entry, "cli.js");
          if (existsSync(cliPath)) return cliPath;
        }
      }
    }
  }

  return null;
}

/** Helper: find the latest version binary/entrypoint in a `versions/` directory. */
function findLatestVersionBinary(versionsDir: string): string | null {
  try {
    const entries = readdirSync(versionsDir);
    if (entries.length === 0) return null;

    const sorted = [...entries].sort((a, b) => compareVersions(b, a));
    const latestVersion = sorted[0] as string;
    const versionPath = path.join(versionsDir, latestVersion);

    const stat = statSync(versionPath);
    if (stat.isFile()) return versionPath;
    if (stat.isDirectory()) {
      const exePath = path.join(
        versionPath,
        process.platform === "win32" ? "claude.exe" : "claude",
      );
      if (existsSync(exePath)) return exePath;
      const cliPath = path.join(versionPath, "cli.js");
      if (existsSync(cliPath)) return cliPath;
    }
  } catch {
    // Directory read failed
  }
  return null;
}

/**
 * Find path to native-installer Claude Code CLI.
 *
 * Installation locations:
 * - macOS/Linux: `~/.local/bin/claude` (symlink) -> `~/.local/share/claude/versions/<version>`
 * - Windows: `%LOCALAPPDATA%\Claude\` or `%USERPROFILE%\.claude\`
 * - Legacy: `~/.claude/local/`
 */
export function findNativeInstallerCliPath(): string | null {
  const homeDir = homedir();

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");

    const windowsClaudePath = path.join(localAppData, "Claude");
    if (existsSync(windowsClaudePath)) {
      const versionsDir = path.join(windowsClaudePath, "versions");
      if (existsSync(versionsDir)) {
        const found = findLatestVersionBinary(versionsDir);
        if (found) return found;
      }
      const exePath = path.join(windowsClaudePath, "claude.exe");
      if (existsSync(exePath)) return exePath;
      const cliPath = path.join(windowsClaudePath, "cli.js");
      if (existsSync(cliPath)) return cliPath;
    }

    const dotClaudePath = path.join(homeDir, ".claude");
    if (existsSync(dotClaudePath)) {
      const versionsDir = path.join(dotClaudePath, "versions");
      if (existsSync(versionsDir)) {
        const found = findLatestVersionBinary(versionsDir);
        if (found) return found;
      }
      const exePath = path.join(dotClaudePath, "claude.exe");
      if (existsSync(exePath)) return exePath;
    }
  }

  // Check ~/.local/bin/claude symlink (most common on macOS/Linux).
  const localBinPath = path.join(homeDir, ".local", "bin", "claude");
  const resolvedLocalBinPath = resolvePathSafe(localBinPath);
  if (resolvedLocalBinPath) return resolvedLocalBinPath;

  // Check ~/.local/share/claude/versions/ (native installer location).
  const versionsDir = path.join(homeDir, ".local", "share", "claude", "versions");
  if (existsSync(versionsDir)) {
    const found = findLatestVersionBinary(versionsDir);
    if (found) return found;
  }

  // Check ~/.claude/local/ (older installation method).
  const nativeBasePath = path.join(homeDir, ".claude", "local");
  if (existsSync(nativeBasePath)) {
    const cliPath = path.join(
      nativeBasePath,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js",
    );
    if (existsSync(cliPath)) return cliPath;
    const directCliPath = path.join(nativeBasePath, "cli.js");
    if (existsSync(directCliPath)) return directCliPath;
  }

  return null;
}

/**
 * Find path to the globally installed Claude Code CLI.
 * Priority: `KVY_CLAUDE_PATH` > PATH > npm > Bun > Homebrew > Native installer.
 */
export function findGlobalClaudeCliPath(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCliLocation | null {
  // 1. Environment variable (explicit override).
  const envPath = env.KVY_CLAUDE_PATH;
  if (envPath && existsSync(envPath)) {
    const resolved = resolvePathSafe(envPath) ?? envPath;
    return { path: resolved, source: "KVY_CLAUDE_PATH" };
  }

  // 2. Check PATH (respects the user's shell config).
  const pathResult = findClaudeInPath();
  if (pathResult) return pathResult;

  // 3. Fall back to package-manager-specific detection.
  const npmPath = findNpmGlobalCliPath();
  if (npmPath) return { path: npmPath, source: "npm" };

  const bunPath = findBunGlobalCliPath();
  if (bunPath) return { path: bunPath, source: "Bun" };

  const homebrewPath = findHomebrewCliPath();
  if (homebrewPath) return { path: homebrewPath, source: "Homebrew" };

  const nativePath = findNativeInstallerCliPath();
  if (nativePath) return { path: nativePath, source: "native installer" };

  return null;
}

/** Get the installed Claude Code version, from the adjacent package.json or `--version`. */
export function getVersion(cliPath: string): string | null {
  try {
    const pkgPath = path.join(path.dirname(cliPath), "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch {
    // fall through to --version
  }

  try {
    const isJsFile = cliPath.endsWith(".js") || cliPath.endsWith(".cjs");
    const command = isJsFile ? process.execPath : cliPath;
    const args = isJsFile ? [cliPath, "--version"] : ["--version"];
    const output = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match?.[1] ?? null;
  } catch {
    // Both lookups failed
  }

  return null;
}

/** Compare semver-ish `x.y.z` version strings. 1 if a>b, -1 if a<b, 0 if equal or malformed. */
export function compareVersions(a: string, b: string): number {
  if (!a || !b) return 0;
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}
