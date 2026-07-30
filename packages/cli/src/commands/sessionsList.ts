/**
 * `falcon sessions list` (falcon-prd.md §5.3, plan.md §16 "4.2 Adoption Tier
 * 3 + polish"). Lists the account's sessions from two independent sources —
 * neither one alone answers "what can I `falcon resume`":
 *
 *  - **Local**: `adopt/listSessions.ts`'s `listAdoptableSessions` (the same
 *    building block `falcon adopt --list` already uses) — plain (unmanaged)
 *    Claude Code transcripts for cwd's workspace, on this machine only, not
 *    yet known to the server at all.
 *  - **Remote**: `GET /v1/sessions` (design §4.3/§6.2, already landed in
 *    `server/src/app/routes/sessions.ts`) — every session row this account
 *    owns, on any machine. Only `tag`/`provider`/`status`/timestamps are
 *    plaintext on the wire (design §5.3: `metadata` stays an opaque
 *    encrypted box the server never reads) — decrypting a session's title
 *    needs the per-session DEK-unwrap machinery the web client carries
 *    (`crypto/worker-handler.ts`'s `unwrapDek`, keyed off the account's
 *    content key tree), which this CLI doesn't have wired yet. Remote rows
 *    are therefore listed by id/`tag`, not a decrypted title — still enough
 *    to pick a target for `falcon resume <id>`.
 *
 * The remote half is skipped (not an error) when the account isn't logged
 * in, and reported inline (not a hard failure) on a network/HTTP error —
 * same "best-effort, never crashes the CLI over the network" philosophy as
 * `api/sessionStatus.ts`; the local half is still useful entirely on its
 * own either way.
 */
import type { ProviderSessionSummary, SessionRow } from "@falcon/wire";
import { listAdoptableSessions } from "../adopt/listSessions.js";
import type { LivenessDeps } from "../adopt/liveness.js";
import { resolveBackendUrl } from "../auth/config.js";
import {
  type FalconCredentials,
  readCredentials as readCredentialsDefault,
} from "../auth/credentials.js";
import { resolveAccessToken } from "../auth/resolveAccessToken.js";
import type { Logger } from "../logger.js";

export interface SessionsListCommandDeps {
  workingDirectory: string;
  env?: NodeJS.ProcessEnv;
  backendUrl?: string;
  liveness?: LivenessDeps;
  /** Injectable for tests; defaults to `auth/credentials.ts`'s real, `~/.falcon/access.key`-backed reader. */
  readCredentials?: () => FalconCredentials | null;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  write?: (text: string) => void;
  logger?: Logger;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const REMOTE_LIST_LIMIT = 50;
const REMOTE_TIMEOUT_MS = 5000;

type RemoteSessionsResult =
  | { type: "ok"; sessions: SessionRow[] }
  | { type: "not-logged-in" }
  | { type: "error"; message: string };

async function fetchRemoteSessions(
  backendUrl: string,
  credentials: FalconCredentials | null,
  fetchImpl: typeof fetch,
  logger: Logger,
): Promise<RemoteSessionsResult> {
  if (!credentials) return { type: "not-logged-in" };

  const accessToken = await resolveAccessToken(credentials, { backendUrl, fetchImpl, logger });
  if (!accessToken) return { type: "not-logged-in" };

  try {
    const res = await fetchImpl(`${backendUrl}/v1/sessions?limit=${REMOTE_LIST_LIMIT}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("[sessions-list] server rejected list request", { status: res.status });
      return { type: "error", message: `server responded ${res.status}` };
    }
    const body = (await res.json()) as { sessions?: SessionRow[] };
    return { type: "ok", sessions: body.sessions ?? [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[sessions-list] failed to reach backend", { error: message });
    return { type: "error", message };
  }
}

function formatLocal(sessions: ProviderSessionSummary[]): string {
  if (sessions.length === 0) return "  (none for this directory)\n";
  return `${sessions
    .map((s) => {
      const when = new Date(s.lastActivityAt).toISOString();
      const marker = s.running ? " [running]" : "";
      return `  ${s.providerSessionId}  ${when}  ${s.title ?? "(untitled)"}${marker}`;
    })
    .join("\n")}\n`;
}

function formatRemote(sessions: SessionRow[]): string {
  if (sessions.length === 0) return "  (none)\n";
  return `${sessions
    .map((s) => {
      const when = new Date(s.updatedAt).toISOString();
      return `  ${s.id}  ${when}  [${s.provider}/${s.status}]  ${s.tag}`;
    })
    .join("\n")}\n`;
}

/**
 * Runs `falcon sessions list`. Always returns 0 — a network/auth issue on
 * the remote half is reported inline, never a hard command failure.
 */
export async function runSessionsListCommand(deps: SessionsListCommandDeps): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const logger = deps.logger ?? noopLogger;
  const env = deps.env ?? process.env;
  const backendUrl = deps.backendUrl ?? resolveBackendUrl(env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readCreds = deps.readCredentials ?? readCredentialsDefault;

  const local = await listAdoptableSessions({
    workingDirectory: deps.workingDirectory,
    env,
    liveness: deps.liveness,
  });
  write(`Local sessions (${deps.workingDirectory}):\n`);
  write(formatLocal(local));

  const remote = await fetchRemoteSessions(backendUrl, readCreds(), fetchImpl, logger);
  write("\nRemote sessions (this account, all machines):\n");
  switch (remote.type) {
    case "not-logged-in":
      write("  not logged in. Run `falcon auth login` to see sessions from other machines\n");
      break;
    case "error":
      write(`  could not reach the Falcon server: ${remote.message}\n`);
      break;
    case "ok":
      write(formatRemote(remote.sessions));
      break;
  }

  return 0;
}
