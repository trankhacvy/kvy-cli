import { execFileSync } from "node:child_process";

/**
 * `ProviderAdapter.detect()`/`startLocal()` for Codex (design §7.3/§7.7,
 * plan.md §16 "3.4 Codex adapter": "`startLocal()` = null with honest CLI
 * note").
 *
 * Mirrors `../provider/claudeProviderAdapter.ts`'s shape (a small object
 * exposing only the interface members this task actually implements,
 * `detect()` + `startLocal()` — not a class `implements ProviderAdapter`
 * with throwing stubs for the unbuilt `startRemote`/`listRecentSessions`/
 * `importTranscript` members). Kept in `codex/` rather than `provider/`
 * (where the Claude equivalent lives) so this fully independent subsystem
 * has zero file overlap with in-flight `provider/` work.
 *
 * The one deliberate, load-bearing difference from Claude's adapter:
 * `startLocal()` always returns `null`. Design §7.3's `ProviderAdapter`
 * interface documents this directly — "`startLocal(opts): LocalHandle |
 * null; // null => provider has no local TUI (codex)" — and §7.7 spells out
 * why: Codex has no local-interactive mode analogous to Claude Code's real
 * TUI; `codex app-server` is *always* the programmatic, JSON-RPC-driven
 * path. Rather than a silent no-op or a thrown "not supported" error, the
 * CLI surfaces `CODEX_NO_LOCAL_MODE_NOTE` — an honest, printed explanation —
 * matching the design principle that a provider limitation must be told to
 * the user, never hidden.
 */

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

/**
 * Printed by `falcon codex` before starting a session (index.ts) — the
 * honest note design §7.7 calls for in place of a silent/missing local
 * mode: "`falcon codex` always runs the programmatic path with the Ink
 * status view; `startLocal()` returns null and the CLI prints an honest
 * note."
 */
export const CODEX_NO_LOCAL_MODE_NOTE =
  "Codex has no local terminal mode — `codex app-server` only supports the programmatic path, so this session is driven remotely from the start (Ctrl-T take-back doesn't apply here).";

export interface DetectCodexOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides `codex --version`. Defaults to a real `execFileSync` call — injectable so tests never shell out to a real `codex` install. */
  resolveVersion?: () => string | null;
}

function defaultResolveVersion(): string | null {
  try {
    // `timeout: 3000` matches `claudeCliLocator.ts`/`claudeAuth.ts`'s own
    // version-check calls — PRD FR-2.7's "never hang" applies here too: a
    // `codex` on PATH that reads stdin or hangs must not block detection
    // forever.
    return execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

/**
 * Detects whether the Codex CLI (specifically its `app-server` subcommand,
 * which this adapter depends on) is installed. Codex authenticates via its
 * own `codex login` / `OPENAI_API_KEY` outside Falcon's control — there is
 * no Falcon-observable "authenticated" check equivalent to Claude's
 * `~/.claude` credential file, so `authenticated` always mirrors `installed`
 * here (an honest "we can't tell, so we don't claim to" rather than
 * fabricating a check that isn't real).
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

/** Always `null` — see file header. `opts` is unused (no local TUI to configure) but kept for interface-shape parity with `ProviderAdapter.startLocal`. */
export function startLocal(_opts: unknown): null {
  return null;
}

/** The Codex provider adapter's `id`/`detect()`/`startLocal()` members (design §7.3's `ProviderAdapter` shape). */
export const codexProvider = {
  id: "codex" as const,
  detect: detectCodex,
  startLocal,
};
