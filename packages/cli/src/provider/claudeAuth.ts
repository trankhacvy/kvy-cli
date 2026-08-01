import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Determines whether the locally-installed Claude Code CLI has usable
 * credentials. New code (plan.md §16, "1.3 CLI skeleton + local mode" —
 * "Provider detection: locate Claude Code install + auth state") — Happy
 * has no equivalent: it just launches `claude` and lets the child process
 * handle its own login prompt. Kvy checks proactively so `detect()` can
 * surface PRD FR-2.7's actionable "Provider not authenticated" error
 * instead of silently spawning a session that then hangs waiting on a
 * login prompt no one is watching (e.g. a remote-spawned session).
 *
 * Checked in order, matching how the Claude Code CLI itself resolves auth:
 * 1. `ANTHROPIC_API_KEY` — direct API-key auth, no OAuth needed.
 * 2. `CLAUDE_CODE_OAUTH_TOKEN` — long-lived token for headless/CI use
 *    (`claude setup-token`).
 * 3. `~/.claude/.credentials.json` — the OAuth credential file the CLI
 *    writes on Linux, and on macOS/Windows whenever the OS keychain is
 *    unavailable (containers, CI, `--dangerously-skip-permissions` boxes).
 * 4. macOS Keychain (`security` CLI) — where the OAuth credentials live by
 *    default on macOS when the file fallback above isn't used.
 *
 * Best-effort throughout: every check swallows its own errors and falls
 * through rather than throwing, so a locked keychain, unreadable file, or
 * missing `security` binary degrades to "not authenticated" (with the
 * actionable fix message from `claudeProviderAdapter.ts`) rather than
 * crashing `kvy`.
 */

export interface ClaudeAuthCheckOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /**
   * Overrides the macOS Keychain lookup. Defaults to a real `security` CLI
   * check. Tests inject this instead of relying on the host machine's
   * actual Keychain state, which is both unpredictable (a dev machine
   * running these tests may itself have Claude Code signed in) and
   * unrelated to `homeDir`/`env`, the two other inputs this function is
   * meant to isolate per-test.
   */
  checkMacKeychain?: () => boolean;
}

const CREDENTIALS_FILE_RELATIVE_PATH = [".claude", ".credentials.json"];
const MACOS_KEYCHAIN_SERVICE = "Claude Code-credentials";

interface ClaudeCredentialsFile {
  claudeAiOauth?: { accessToken?: string };
}

function hasCredentialsEnvVar(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim()) || Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
}

function hasCredentialsFile(homeDir: string): boolean {
  const filePath = path.join(homeDir, ...CREDENTIALS_FILE_RELATIVE_PATH);
  if (!existsSync(filePath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as ClaudeCredentialsFile;
    return Boolean(parsed.claudeAiOauth?.accessToken?.trim());
  } catch {
    // Unreadable or malformed — treat as absent rather than throwing.
    return false;
  }
}

function hasMacKeychainCredentials(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    // Deliberately omit `-w`: that flag extracts the actual secret value
    // from the Keychain, which this presence-only check doesn't need.
    // `security` exits non-zero when no matching entry exists, which is
    // sufficient to detect presence without ever reading the credential
    // into this process.
    execFileSync("security", ["find-generic-password", "-s", MACOS_KEYCHAIN_SERVICE], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    return true;
  } catch {
    // Not found, keychain locked, or `security` unavailable.
    return false;
  }
}

/** Returns whether the Claude Code CLI has usable auth credentials on this machine. */
export function isClaudeCodeAuthenticated(options: ClaudeAuthCheckOptions = {}): boolean {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const checkMacKeychain = options.checkMacKeychain ?? hasMacKeychainCredentials;

  return hasCredentialsEnvVar(env) || hasCredentialsFile(homeDir) || checkMacKeychain();
}
