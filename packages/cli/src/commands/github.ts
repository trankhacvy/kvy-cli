/**
 * `falcon github login [--token] [--client-id <id>]` / `logout` / `status`
 * (docs/features/github-pr-ci.md "GITHUB AUTH"). Local-only, no daemon
 * interaction (same rationale as `workspace config`/`adapters`): this reads/
 * writes `~/.falcon/github.key` directly (`../github/githubAuth.js`) and
 * talks to GitHub's own REST API over plain `fetch`, never Falcon's server —
 * the whole point of this token is that the server never sees it (design
 * §5.3/§6.1).
 *
 * `--token` prompts for a PAT on stdin rather than accepting it as a bare
 * argv value — a token passed as `--token <value>` would land in shell
 * history and `ps`'s process listing, exactly the kind of exposure this
 * module exists to avoid. Without `--token`, `login` runs the GitHub device
 * authorization flow (`../github/deviceFlow.js`), which needs a client id:
 * `--client-id` wins, then `FALCON_GITHUB_CLIENT_ID`, then
 * `DEFAULT_GITHUB_CLIENT_ID` below — empty until a Falcon GitHub OAuth app
 * with Device Flow enabled actually exists (docs/features/github-pr-ci.md's
 * risk note), so `falcon github login` with no flags and no configured
 * client id fails fast with an explicit "use --token instead" message
 * rather than hanging on a device code request that was never going to
 * succeed.
 */
import { createInterface } from "node:readline/promises";
import { pollForToken, requestDeviceCode } from "../github/deviceFlow.js";
import { clearGithubToken, readGithubToken, writeGithubToken } from "../github/githubAuth.js";

/** No Falcon GitHub OAuth app with Device Flow enabled exists yet (docs/features/github-pr-ci.md risk note: "Device-flow client id"). Set `FALCON_GITHUB_CLIENT_ID` or pass `--client-id` once one does. */
export const DEFAULT_GITHUB_CLIENT_ID = "";

export interface GithubLoginOptions {
  /** `--token`: prompt for a PAT instead of running the device flow. */
  useToken: boolean;
  clientId?: string;
}

export interface GithubCommandDeps {
  homeDir?: string;
  write?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test seam for reading the pasted PAT; defaults to a real stdin prompt. */
  readSecretLine?: (prompt: string) => Promise<string>;
}

async function defaultReadSecretLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

function resolveClientId(options: GithubLoginOptions, env: NodeJS.ProcessEnv): string {
  return options.clientId ?? env.FALCON_GITHUB_CLIENT_ID ?? DEFAULT_GITHUB_CLIENT_ID;
}

/** Runs `falcon github login`. Returns 1 (no token saved) if `--token` produced an empty paste, or if the device flow has no usable client id — never throws for either expected case. */
export async function runGithubLogin(
  options: GithubLoginOptions,
  deps: GithubCommandDeps = {},
): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());

  if (options.useToken) {
    const readSecretLine = deps.readSecretLine ?? defaultReadSecretLine;
    const token = await readSecretLine(
      "Paste a GitHub personal access token (repo, read:checks scopes): ",
    );
    if (!token) {
      write("falcon github login: no token entered — nothing saved.\n");
      return 1;
    }
    writeGithubToken({ token, createdAt: now(), method: "pat" }, deps.homeDir);
    write("Saved GitHub token to this machine.\n");
    return 0;
  }

  const clientId = resolveClientId(options, env);
  if (!clientId) {
    write(
      "falcon github login: no GitHub OAuth client id is configured yet.\n" +
        "Run `falcon github login --token` and paste a personal access token instead,\n" +
        "or set FALCON_GITHUB_CLIENT_ID / pass --client-id once a Falcon GitHub OAuth app exists.\n",
    );
    return 1;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const deviceCode = await requestDeviceCode({ clientId, fetchImpl });
  write(`Go to ${deviceCode.verificationUri} and enter code: ${deviceCode.userCode}\n`);
  write("Waiting for approval...\n");

  const result = await pollForToken({
    clientId,
    deviceCode: deviceCode.deviceCode,
    interval: deviceCode.interval,
    fetchImpl,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  writeGithubToken(
    { token: result.accessToken, createdAt: now(), scope: result.scope, method: "device-flow" },
    deps.homeDir,
  );
  write(`Logged in to GitHub (scope: ${result.scope || "(none)"}).\n`);
  return 0;
}

/** Runs `falcon github logout`. Always returns 0 — a no-op when there was nothing to clear, same contract as `clearGithubToken` itself. */
export function runGithubLogout(deps: GithubCommandDeps = {}): number {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  clearGithubToken(deps.homeDir);
  write("Logged out of GitHub on this machine.\n");
  return 0;
}

/** Runs `falcon github status`: reports whether a token is stored, and — if so — verifies it live against GitHub's `/user` endpoint (never against Falcon's own server, which never sees this token) and reports the granted scopes from the `X-OAuth-Scopes` response header. Returns 1 for "not connected" and for a rejected/invalid token, so scripting can detect either. */
export async function runGithubStatus(deps: GithubCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const token = readGithubToken(deps.homeDir);
  if (!token) {
    write("falcon github status: not connected to GitHub on this machine.\n");
    return 1;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    write(
      "falcon github status: invalid token — GitHub rejected it. Run `falcon github login` again.\n",
    );
    return 1;
  }

  const user = (await response.json()) as { login?: string };
  const scopes = response.headers.get("x-oauth-scopes") ?? token.scope ?? "";
  write(`Logged in to GitHub as ${user.login ?? "(unknown)"} (scopes: ${scopes || "(none)"}).\n`);
  return 0;
}
