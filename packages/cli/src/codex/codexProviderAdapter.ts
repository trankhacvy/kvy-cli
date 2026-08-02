import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface ProviderDetectionResult {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  /** Set whenever `installed` or `authenticated` is false: a human-readable, actionable fix. */
  error?: string;
}

export const CODEX_NOT_INSTALLED_MESSAGE = [
  "Codex CLI is not installed.",
  "Install it with one of:",
  "  npm install -g @openai/codex",
  "  brew install --cask codex",
].join("\n");

export const CODEX_NO_LOCAL_MODE_NOTE =
  "Codex has no local terminal mode: `codex app-server` only supports the programmatic path, so this session is driven remotely from the start (Ctrl-T take-back doesn't apply here).";

export interface DetectCodexOptions {
  /** Overrides `codex --version`. Defaults to a real `execFileSync` call — injectable so tests never shell out to a real `codex` install. */
  resolveVersion?: () => string | null;
}

function findCodexInPath(): string | null {
  try {
    const command = process.platform === "win32" ? "where codex" : "which codex";
    const result = execSync(command, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

    const codexPath = result.split("\n")[0]?.trim();
    if (!codexPath) return null;
    if (!existsSync(codexPath)) return null;

    return codexPath;
  } catch {
    // `codex` not on PATH.
    return null;
  }
}

function defaultResolveVersion(): string | null {
  const codexPath = findCodexInPath();
  if (!codexPath) return null;
  try {
    // 3s timeout: a `codex` on PATH that reads stdin or hangs must not block detection forever.
    return execFileSync(codexPath, ["--version"], { encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

/**
 * `authenticated` always mirrors `installed` — Codex authenticates via its own
 * `codex login` / `OPENAI_API_KEY` outside Kvy's control, so there is no
 * Kvy-observable credential check.
 */
export async function detectCodex(
  options: DetectCodexOptions = {},
): Promise<ProviderDetectionResult> {
  const resolveVersion = options.resolveVersion ?? defaultResolveVersion;
  const version = resolveVersion();

  if (!version) {
    return { installed: false, authenticated: false, error: CODEX_NOT_INSTALLED_MESSAGE };
  }
  return { installed: true, authenticated: true, version };
}

/** Always `null` — Codex has no local-interactive TUI. `opts` kept for interface-shape parity. */
export function startLocal(_opts: unknown): null {
  return null;
}

export const codexProvider = {
  id: "codex" as const,
  detect: detectCodex,
  startLocal,
};
