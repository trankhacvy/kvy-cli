/**
 * `~/.kvy/github.key` — machine-local GitHub token store. The token never
 * reaches the Kvy server, so it gets its own file next to `access.key` rather
 * than folding into `settings.json` — that file is already read unencrypted
 * by the daemon for non-secret config, and this token has no business near it.
 *
 * The token value is never logged: callers pass it straight into an
 * `Authorization` header and never into a `Logger` call or thrown error message.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveHomeDir } from "../home.js";

const GithubTokenSchema = z.object({
  token: z.string().min(1),
  createdAt: z.number(),
  // PAT scope is unknown at write time; filled in lazily by `kvy github status`'s
  // live X-OAuth-Scopes read.
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
 * Reads and validates `~/.kvy/github.key`. Never throws — a missing or
 * malformed file means "not connected to GitHub on this machine". Read fresh
 * on every call (no in-process cache) so a `kvy github login` run while the
 * daemon is up takes effect on its very next `github.checks` RPC without a
 * restart.
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

/** Writes `~/.kvy/github.key` chmod 0600. `fs.writeFileSync`'s `mode` option only applies on file creation, so an existing file is chmod'd explicitly too. */
export function writeGithubToken(token: GithubToken, homeDir: string = resolveHomeDir()): void {
  if (!existsSync(homeDir)) mkdirSync(homeDir, { recursive: true });
  const file = githubTokenPath(homeDir);
  writeFileSync(file, `${JSON.stringify(token, null, 2)}\n`, { mode: GITHUB_TOKEN_FILE_MODE });
  chmodSync(file, GITHUB_TOKEN_FILE_MODE);
}

/** No-op if there's nothing to clear. */
export function clearGithubToken(homeDir: string = resolveHomeDir()): void {
  const file = githubTokenPath(homeDir);
  if (existsSync(file)) unlinkSync(file);
}
