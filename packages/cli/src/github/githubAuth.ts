/**
 * `~/.falcon/github.key` persistence — the machine-local GitHub token store
 * (docs/features/github-pr-ci.md "GITHUB AUTH (daemon-local, the key
 * decision)"). Port of `auth/credentials.ts`'s exact pattern (same
 * sync-fs-calls shape, same 0600-permissioned single-file-per-secret
 * convention): the GitHub token is a machine-local secret that never
 * reaches the Falcon server (design §5.3/§6.1: the server decrypts
 * nothing), so it gets its own file next to `access.key` rather than
 * folding into `settings.json` — that file is already read unencrypted by
 * the daemon for other, non-secret config (`workspaceConfig.ts`), and this
 * token has no business anywhere near it.
 *
 * The token value is never logged: callers (`daemon/githubChecks.ts`,
 * `commands/github.ts`) pass it straight into an `Authorization` header and
 * never into a `Logger` call or thrown `Error` message.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveHomeDir } from "../home.js";

const GithubTokenSchema = z.object({
  token: z.string().min(1),
  createdAt: z.number(),
  // GitHub's own granted-scope string (device flow: reported alongside the
  // access token; PAT: unknown at write time, filled in lazily by `falcon
  // github status`'s live `X-OAuth-Scopes` read — see commands/github.ts).
  scope: z.string().optional(),
  method: z.enum(["device-flow", "pat"]),
});

export type GithubToken = z.infer<typeof GithubTokenSchema>;

// Owner read/write only — this file holds a repo-scoped GitHub token.
const GITHUB_TOKEN_FILE_MODE = 0o600;

export function githubTokenPath(homeDir: string = resolveHomeDir()): string {
  return path.join(homeDir, "github.key");
}

/**
 * Reads and validates `~/.falcon/github.key`. Never throws (same contract
 * as `auth/credentials.ts`'s `readCredentials`) — a missing, unreadable, or
 * malformed file just means "not connected to GitHub on this machine", not
 * an exceptional condition callers need to catch. Read fresh on every call
 * (no in-process cache) so a `falcon github login` run while the daemon is
 * already up takes effect on the daemon's very next `github.checks` RPC,
 * without a restart.
 */
export function readGithubToken(homeDir: string = resolveHomeDir()): GithubToken | null {
  const file = githubTokenPath(homeDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = GithubTokenSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Writes `~/.falcon/github.key`, chmod 0600 (same rationale as `writeCredentials`: `fs.writeFileSync`'s `mode` option only applies when the file is *created*, so a re-login over an existing file is chmod'd explicitly too). */
export function writeGithubToken(token: GithubToken, homeDir: string = resolveHomeDir()): void {
  if (!existsSync(homeDir)) mkdirSync(homeDir, { recursive: true });
  const file = githubTokenPath(homeDir);
  writeFileSync(file, `${JSON.stringify(token, null, 2)}\n`, { mode: GITHUB_TOKEN_FILE_MODE });
  chmodSync(file, GITHUB_TOKEN_FILE_MODE);
}

/** `falcon github logout` — a no-op if there's nothing to clear. */
export function clearGithubToken(homeDir: string = resolveHomeDir()): void {
  const file = githubTokenPath(homeDir);
  if (existsSync(file)) unlinkSync(file);
}
