import { type ClaudeAuthCheckOptions, isClaudeCodeAuthenticated } from "./claudeAuth.js";
import { type ClaudeCliLocation, findGlobalClaudeCliPath, getVersion } from "./claudeCliLocator.js";

/**
 * `ProviderAdapter.detect()` for Claude Code (design §7.3, plan.md §16
 * "1.3 CLI skeleton + local mode" — "Provider detection: locate Claude Code
 * install + auth state; actionable error copy (PRD FR-2.7)").
 *
 * This module implements only `detect()`. The rest of the `ProviderAdapter`
 * interface (`startLocal`, `startRemote`, `listRecentSessions`,
 * `importTranscript`) is separate, not-yet-built plan.md work (the launcher,
 * `claudeLocal.ts` port, and transcript pipeline tasks) — it is
 * deliberately not stubbed out here so this file stays fully implemented
 * rather than half-finished.
 */

export interface ProviderDetectionResult {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  /**
   * Set whenever `installed` or `authenticated` is false: a human-readable,
   * actionable fix — never a silent hang (PRD FR-2.7).
   */
  error?: string;
}

export const CLAUDE_NOT_INSTALLED_MESSAGE = [
  "Claude Code is not installed.",
  "Install it with one of:",
  "  npm install -g @anthropic-ai/claude-code",
  "  brew install claude-code",
  "  curl -fsSL https://claude.ai/install.sh | bash",
].join("\n");

export const CLAUDE_NOT_AUTHENTICATED_MESSAGE = [
  "Provider not authenticated: Claude Code is installed but not signed in.",
  "Fix: run `claude` and complete the /login flow, or set ANTHROPIC_API_KEY.",
].join("\n");

export interface DetectClaudeCodeOptions extends ClaudeAuthCheckOptions {
  /**
   * Overrides CLI location lookup. Defaults to `findGlobalClaudeCliPath`.
   * Locating the real CLI shells out to `which`/`npm`/etc. against the
   * *actual* machine (matching Happy's `HAPPY_CLAUDE_PATH`-only-overrides-
   * step-1 behavior — see `claudeCliLocator.ts`), which real process env
   * vars can't fully sandbox. Tests inject a fake locator here instead of
   * relying on the host machine having (or lacking) a real Claude Code
   * install.
   */
  locate?: (env: NodeJS.ProcessEnv) => ClaudeCliLocation | null;
  /** Overrides version lookup. Defaults to `getVersion`. */
  resolveVersion?: (cliPath: string) => string | null;
}

/**
 * Detects whether Claude Code is installed, authenticated, and its version.
 * Never throws and never hangs: every underlying check (`locate`,
 * `resolveVersion`, `isClaudeCodeAuthenticated`) is already
 * best-effort/synchronous, so this always resolves promptly with a result —
 * `installed`/`authenticated` false plus an actionable `error` rather than
 * an exception, satisfying PRD FR-2.7.
 */
export async function detectClaudeCode(
  options: DetectClaudeCodeOptions = {},
): Promise<ProviderDetectionResult> {
  const env = options.env ?? process.env;
  const locate = options.locate ?? findGlobalClaudeCliPath;
  const resolveVersion = options.resolveVersion ?? getVersion;

  const location = locate(env);
  if (!location) {
    return { installed: false, authenticated: false, error: CLAUDE_NOT_INSTALLED_MESSAGE };
  }

  const version = resolveVersion(location.path);
  const authenticated = isClaudeCodeAuthenticated(options);

  if (!authenticated) {
    return {
      installed: true,
      authenticated: false,
      ...(version ? { version } : {}),
      error: CLAUDE_NOT_AUTHENTICATED_MESSAGE,
    };
  }

  return { installed: true, authenticated: true, ...(version ? { version } : {}) };
}

/**
 * The Claude Code provider adapter's `id` + `detect()` members (design
 * §7.3's `ProviderAdapter` shape). Exposed as a small object rather than a
 * class implementing the full interface, since the rest of the interface
 * isn't built yet — a class declared `implements ProviderAdapter` would
 * need throwing stub methods for the unbuilt members, which is exactly the
 * half-finished code this task is meant to avoid.
 */
export const claudeCodeProvider = {
  id: "claude-code" as const,
  detect: detectClaudeCode,
};
