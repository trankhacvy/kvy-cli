/**
 * Session bootstrap — plan.md §16 "1.3 CLI skeleton + local mode": mint a
 * fresh session DEK, wrap it to the account's X25519 content public key
 * (design §5.1), and call the already-merged `POST /v1/sessions` (design
 * §4.3/§6.2) to create-or-get the session row. Returns the sessionId + the
 * DEK actually in force for that row, for the transcript tailer and mode
 * loop to encrypt/decrypt content with.
 *
 * `POST /v1/sessions` is idempotent by `(accountId, tag)` — calling this
 * twice with the same `machineId`/`workspacePath`/`nonce` triple hits the
 * same row instead of minting a duplicate. On that replay path the server
 * discards our freshly-minted DEK and returns the *original* row (including
 * its original wrapped DEK) — this module unwraps that with the caller's
 * content secret key rather than handing back the locally-minted-but-unused
 * one, so a resumed session always gets the DEK its existing transcript was
 * actually encrypted with (returning the wrong key here would be a silent
 * correctness bug, not just a wasted key — design principle: no silent
 * failures).
 *
 * Unlike `daemon/notify.ts`'s best-effort self-report, this call is
 * load-bearing: without a session row + DEK there is nothing for the
 * transcript tailer to write to, so failures are thrown, not swallowed.
 *
 * Auth-token retrieval is an injectable seam (same shape as `notify.ts`'s
 * `fetchImpl`) so this module has no hard dependency on the not-yet-merged
 * `falcon auth login` CLI work — callers pass a `getAuthToken` function
 * (sync or async) that returns a bearer token.
 *
 * **Resume (plan-v2.md W3.7, design v0.3 §7.4):** a re-spawned session
 * process (`daemon/resumeSession.ts`'s `FALCON_RECONNECT_*` env contract —
 * currently only set by the daemon's own headless resume path) must keep
 * writing into its *existing* server-side session row, never mint a fresh
 * one under a brand-new nonce — a second row for the same logical session
 * would silently fork the transcript the web UI already has cached. When
 * `FALCON_RECONNECT_SESSION_ID` is present this call skips `POST
 * /v1/sessions` entirely and re-attaches locally: the wrapped DEK already
 * travelled via `FALCON_RECONNECT_ENCRYPTION_KEY` (the same wrapped-DEK
 * shape `/session-started` reports and `sessions.json` persists), so
 * unwrapping it with the caller's content secret key is enough — no network
 * round trip needed, and no new tag is minted (there's nothing to create).
 */
import { createHash } from "node:crypto";
import type { BoxKeyPair } from "@falcon/crypto";
import {
  decodeBase64,
  encodeBase64,
  getRandomBytes,
  seal,
  unwrapDek,
  wrapDek,
} from "@falcon/crypto";
import { type ProviderId, SessionRowSchema } from "@falcon/wire";
import type { Logger } from "../logger.js";

const DEK_LENGTH_BYTES = 32;
const DEFAULT_SERVER_URL = "http://127.0.0.1:3005";

export interface SessionMetadataInput {
  title: string;
  path: string;
  providerSessionId?: string | null;
  /** The `--model` override this session was started with, when the
   * caller's passthrough args carried one (`modelFlag.ts`'s
   * `extractModelFlag`) — display-only, purely for the web header's model
   * chip (plan-v2.md W4.2); `undefined`/absent means "provider default",
   * same "" contract `features/new-session`'s spawn wizard already uses on
   * the web side. Never read back by anything on the CLI side — the actual
   * `--model` flag reaches `claude`/`codex` unchanged, independent of this. */
  model?: string | null;
}

export interface BootstrapSessionParams {
  /** Stable machine identity (plan.md §6.1's `machineId`) — one leg of the idempotent tag. */
  machineId: string;
  /** Absolute workspace path — the other stable leg of the idempotent tag. */
  workspacePath: string;
  /**
   * Caller-supplied nonce distinguishing sessions that share a machine +
   * workspace (e.g. a per-logical-session id the mode loop mints once and
   * persists, then reuses across resume/retry so the tag — and therefore
   * the session row — stays the same).
   */
  nonce: string;
  provider: ProviderId;
  /** Account's X25519 content keypair (design §5.1). The public half wraps
   * the DEK; the secret half recovers the original DEK on an idempotent
   * replay, when the server hands back an existing row instead of ours. */
  contentKeyPair: BoxKeyPair;
  metadata: SessionMetadataInput;
  workspaceId?: string | null;
  executionTarget?: string;
  /**
   * Injectable for tests; defaults to `process.env`. When
   * `FALCON_RECONNECT_SESSION_ID` is set, this call re-attaches to that
   * existing session instead of create-or-getting a fresh one — see the
   * module doc comment above.
   */
  env?: NodeJS.ProcessEnv;
}

export interface BootstrapSessionDeps {
  serverUrl: string;
  /** Injectable so unit tests never make a real network call. */
  fetchImpl: typeof fetch;
  /** Injectable so this module has no hard dependency on `falcon auth login` (not yet merged). */
  getAuthToken: () => string | Promise<string>;
  logger?: Logger;
}

export interface BootstrapSessionResult {
  sessionId: string;
  /** The DEK actually in force for this session — freshly minted on create,
   * recovered via unwrap on an idempotent replay. Never the discarded,
   * locally-minted-but-unused key on the replay path. */
  dek: Uint8Array;
  tag: string;
  /** `true` if this call minted the row, `false` if it hit an existing one. */
  created: boolean;
}

/**
 * Builds deps with sensible defaults (`FALCON_SERVER_URL` env var, global
 * `fetch`); `getAuthToken` has no sane default and must always be supplied.
 */
export function createBootstrapSessionDeps(
  overrides: Partial<Omit<BootstrapSessionDeps, "getAuthToken">> &
    Pick<BootstrapSessionDeps, "getAuthToken">,
): BootstrapSessionDeps {
  return {
    serverUrl: process.env.FALCON_SERVER_URL?.trim() || DEFAULT_SERVER_URL,
    fetchImpl: fetch,
    ...overrides,
  };
}

/**
 * Deterministic idempotency tag: `sha256(machineId | 0x00 | workspacePath |
 * 0x00 | nonce)`, hex-encoded. The same triple always produces the same
 * tag, so re-running this module for the same logical session (e.g. after a
 * crash/resume) hits the server's `(accountId, tag)` unique index and gets
 * the existing row back instead of minting a duplicate (design §4.3/§6.1:
 * "tag = machineId+path+nonce"). The NUL separator prevents boundary
 * collisions (e.g. `machineId="a"` + `workspacePath="bc"` colliding with
 * `machineId="ab"` + `workspacePath="c"`).
 */
export function buildSessionTag(params: {
  machineId: string;
  workspacePath: string;
  nonce: string;
}): string {
  return createHash("sha256")
    .update(params.machineId)
    .update("\x00")
    .update(params.workspacePath)
    .update("\x00")
    .update(params.nonce)
    .digest("hex");
}

/**
 * Re-attaches to an already-existing session (`FALCON_RECONNECT_SESSION_ID`)
 * by unwrapping the wrapped DEK the reconnect env already carries
 * (`FALCON_RECONNECT_ENCRYPTION_KEY`) — no `POST /v1/sessions` call, no fresh
 * tag (there's nothing being created). `tag` on the returned result is `""`:
 * meaningless here since no create-or-get call was made, and unused by every
 * caller (checked: only `bootstrap.test.ts` asserts on `tag`, and only on the
 * create/replay paths).
 */
function reattachSession(
  deps: Pick<BootstrapSessionDeps, "logger">,
  params: { sessionId: string; env: NodeJS.ProcessEnv; contentKeyPair: BoxKeyPair },
): BootstrapSessionResult {
  const { logger } = deps;
  const wrappedDekB64 = params.env.FALCON_RECONNECT_ENCRYPTION_KEY?.trim();
  if (!wrappedDekB64) {
    logger?.error(
      "[session/bootstrap] FALCON_RECONNECT_SESSION_ID set without FALCON_RECONNECT_ENCRYPTION_KEY",
      { sessionId: params.sessionId },
    );
    throw new Error(
      `bootstrapSession: FALCON_RECONNECT_SESSION_ID=${params.sessionId} set without ` +
        "FALCON_RECONNECT_ENCRYPTION_KEY, cannot re-attach without the wrapped DEK",
    );
  }

  const dek = unwrapDek(decodeBase64(wrappedDekB64), params.contentKeyPair.secretKey);
  if (!dek) {
    logger?.error("[session/bootstrap] failed to unwrap reconnect DEK", {
      sessionId: params.sessionId,
    });
    throw new Error(
      `bootstrapSession: could not unwrap the reconnect DEK for session ${params.sessionId}: ` +
        "wrong key, or corrupted/foreign wrap",
    );
  }

  logger?.debug("[session/bootstrap] re-attached via FALCON_RECONNECT_SESSION_ID", {
    sessionId: params.sessionId,
  });
  return { sessionId: params.sessionId, dek, tag: "", created: false };
}

/**
 * Mint a fresh session DEK, wrap it to `contentKeyPair.publicKey`, and
 * create-or-get the session row via `POST /v1/sessions`. Throws on any
 * non-2xx response, network failure, or unwrap failure on the replay path —
 * this is a required startup step, not a best-effort side channel.
 *
 * Short-circuits to `reattachSession()` (no network call at all) when
 * `FALCON_RECONNECT_SESSION_ID` is present in `params.env` — see the module
 * doc comment.
 */
export async function bootstrapSession(
  deps: BootstrapSessionDeps,
  params: BootstrapSessionParams,
): Promise<BootstrapSessionResult> {
  const env = params.env ?? process.env;
  const reconnectSessionId = env.FALCON_RECONNECT_SESSION_ID?.trim();
  if (reconnectSessionId) {
    return reattachSession(deps, {
      sessionId: reconnectSessionId,
      env,
      contentKeyPair: params.contentKeyPair,
    });
  }

  const { serverUrl, fetchImpl, getAuthToken, logger } = deps;
  const tag = buildSessionTag(params);
  const dek = getRandomBytes(DEK_LENGTH_BYTES);
  const wrappedDek = wrapDek(dek, params.contentKeyPair.publicKey);
  const metadataBox = seal(
    {
      title: params.metadata.title,
      path: params.metadata.path,
      providerSessionId: params.metadata.providerSessionId ?? null,
      model: params.metadata.model ?? null,
      // Marks this title as machine-set (currently the working directory's
      // basename) so a later provider-summary auto-title
      // (`sessionMetadata.ts`'s `updateTitle`) knows it's still safe to
      // overwrite — flips to `"manual"` the moment a human renames the
      // session (`rename-session-dialog.tsx`), which then locks the title
      // forever after.
      titleSource: "auto",
    },
    dek,
  );

  const token = await getAuthToken();

  let response: Response;
  try {
    response = await fetchImpl(`${serverUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        tag,
        provider: params.provider,
        workspaceId: params.workspaceId ?? null,
        machineId: params.machineId,
        ...(params.executionTarget ? { executionTarget: params.executionTarget } : {}),
        metadata: metadataBox,
        dek: encodeBase64(wrappedDek),
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error("[session/bootstrap] failed to reach server", { tag, error: message });
    throw new Error(`bootstrapSession: failed to reach ${serverUrl}/v1/sessions: ${message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger?.error("[session/bootstrap] server rejected session create", {
      tag,
      status: response.status,
      body,
    });
    throw new Error(`bootstrapSession: POST /v1/sessions responded ${response.status}: ${body}`);
  }

  const row = SessionRowSchema.parse(await response.json());
  const created = response.status === 201;

  if (created) {
    logger?.debug("[session/bootstrap] session created", { sessionId: row.id, tag });
    return { sessionId: row.id, dek, tag, created };
  }

  // Idempotent replay: the row (and its DEK) already existed. Recover the
  // *original* DEK from the row the server actually returned instead of
  // handing back the one we just minted (and which the server discarded) —
  // otherwise the caller would encrypt new content under a key that doesn't
  // match this session's existing transcript.
  const existingDek = unwrapDek(decodeBase64(row.dek), params.contentKeyPair.secretKey);
  if (!existingDek) {
    logger?.error("[session/bootstrap] failed to unwrap existing session's DEK", {
      sessionId: row.id,
      tag,
    });
    throw new Error(
      `bootstrapSession: could not unwrap existing session ${row.id}'s DEK with the ` +
        "provided content key: wrong key, or corrupted/foreign wrap",
    );
  }

  logger?.debug("[session/bootstrap] session already existed, reused", { sessionId: row.id, tag });
  return { sessionId: row.id, dek: existingDek, tag, created };
}
