/**
 * `kvy github login [--token] [--client-id <id>]` / `logout` / `status`.
 * Local-only, no daemon interaction (same rationale as `workspace
 * config`/`adapters`): this reads/writes `~/.kvy/github.key` directly
 * (`../github/githubAuth.js`) and talks to GitHub's own REST API over plain
 * `fetch`, never Kvy's server — the whole point of this token is that the
 * server never sees it.
 *
 * `--token` prompts for a PAT on stdin rather than accepting it as a bare
 * argv value — a token passed as `--token <value>` would land in shell
 * history and `ps`'s process listing, exactly the kind of exposure this
 * module exists to avoid. Without `--token`, `login` runs the GitHub device
 * authorization flow (`../github/deviceFlow.js`), which needs a client id:
 * `--client-id` wins, then `KVY_GITHUB_CLIENT_ID`, then
 * `DEFAULT_GITHUB_CLIENT_ID` below — empty until a Kvy GitHub OAuth app
 * with Device Flow enabled actually exists, so `kvy github login` with no
 * flags and no configured client id fails fast with an explicit "use
 * --token instead" message rather than hanging on a device code request
 * that was never going to succeed.
 */
import { createInterface } from "node:readline/promises";
import { pollForToken, requestDeviceCode } from "../github/deviceFlow.js";
import { clearGithubToken, readGithubToken, writeGithubToken } from "../github/githubAuth.js";

/** No Kvy GitHub OAuth app with Device Flow enabled exists yet. Set `KVY_GITHUB_CLIENT_ID` or pass `--client-id` once one does. */
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

/**
 * Masks the pasted PAT with `*` instead of echoing it in cleartext (flagged by an independent
 * Test & Review pass on this feature: a bare `rl.question()` echoes every character typed/
 * pasted). Raw-mode masking needs a real TTY on stdin; falls back to the plain `rl.question()`
 * prompt when stdin is piped/redirected (e.g. CI, or a test harness), since raw mode isn't
 * meaningful there and forcing it would hang non-interactive callers.
 */
async function defaultReadSecretLine(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: process.stdout });
    try {
      return (await rl.question(prompt)).trim();
    } finally {
      rl.close();
    }
  }

  return new Promise<string>((resolve, reject) => {
    process.stdout.write(prompt);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") {
          // Ctrl-C: restore the terminal and let the process exit normally, same as an
          // interactive readline prompt would on SIGINT.
          cleanup();
          process.stdout.write("\n");
          reject(new Error("aborted"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        value += char;
        process.stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

function resolveClientId(options: GithubLoginOptions, env: NodeJS.ProcessEnv): string {
  return options.clientId ?? env.KVY_GITHUB_CLIENT_ID ?? DEFAULT_GITHUB_CLIENT_ID;
}

/** Runs `kvy github login`. Returns 1 (no token saved) if `--token` produced an empty paste, or if the device flow has no usable client id — never throws for either expected case. */
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
      write("kvy github login: no token entered, nothing saved.\n");
      return 1;
    }
    writeGithubToken({ token, createdAt: now(), method: "pat" }, deps.homeDir);
    write("Saved GitHub token to this machine.\n");
    return 0;
  }

  const clientId = resolveClientId(options, env);
  if (!clientId) {
    write(
      "kvy github login: no GitHub OAuth client id is configured yet.\n" +
        "Run `kvy github login --token` and paste a personal access token instead,\n" +
        "or set KVY_GITHUB_CLIENT_ID / pass --client-id once a Kvy GitHub OAuth app exists.\n",
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

/** Runs `kvy github logout`. Always returns 0 — a no-op when there was nothing to clear, same contract as `clearGithubToken` itself. */
export function runGithubLogout(deps: GithubCommandDeps = {}): number {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  clearGithubToken(deps.homeDir);
  write("Logged out of GitHub on this machine.\n");
  return 0;
}

/** Runs `kvy github status`: reports whether a token is stored, and — if so — verifies it live against GitHub's `/user` endpoint (never against Kvy's own server, which never sees this token) and reports the granted scopes from the `X-OAuth-Scopes` response header. Returns 1 for "not connected" and for a rejected/invalid token, so scripting can detect either. */
export async function runGithubStatus(deps: GithubCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const token = readGithubToken(deps.homeDir);
  if (!token) {
    write("kvy github status: not connected to GitHub on this machine.\n");
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
    write("kvy github status: invalid token. GitHub rejected it. Run `kvy github login` again.\n");
    return 1;
  }

  const user = (await response.json()) as { login?: string };
  const scopes = response.headers.get("x-oauth-scopes") ?? token.scope ?? "";
  write(`Logged in to GitHub as ${user.login ?? "(unknown)"} (scopes: ${scopes || "(none)"}).\n`);
  return 0;
}
