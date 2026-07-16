/**
 * HTTP client for `POST /v1/unmanaged-sessions` (design §8's "Transcript
 * indexer (adoption Tier 1)" / plan.md §16 "3.3 Session adoption (UC9)").
 *
 * Mints a fresh per-row DEK and seals the plaintext summary under it, the
 * same pattern `session/bootstrap.ts` uses for session metadata (design
 * §5.1) — every write is a brand-new encryption (the row has no
 * client-visible version to CAS against, see the server route's own
 * doc comment), so there is no "recover the existing DEK on replay" branch
 * here the way `bootstrapSession` has for its idempotent-create path.
 */
import {
  encodeBase64,
  getRandomBytes,
  seal,
  wrapDek,
} from "@falcon/crypto";
import type { Logger } from "../logger.js";

const DEK_LENGTH_BYTES = 32;
const DEFAULT_SERVER_URL = "http://127.0.0.1:3005";

/** Plaintext fields sealed into `unmanagedSessions.summary` (design §6.1). */
export interface UnmanagedSessionSummary {
  title: string;
  lastActivity: number;
  running: boolean;
}

export interface UpsertUnmanagedSessionParams {
  machineId: string;
  workspaceId: string;
  providerRef: string;
  summary: UnmanagedSessionSummary;
}

export interface UnmanagedSessionClientDeps {
  serverUrl: string;
  token: string;
  /** Account's X25519 content public key (design §5.1) — wraps the per-row DEK. */
  contentPublicKey: Uint8Array;
  /** Injectable so unit tests never make a real network call. */
  fetchImpl: typeof fetch;
  logger: Logger;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function createUnmanagedSessionClientDeps(
  required: Pick<UnmanagedSessionClientDeps, "token" | "contentPublicKey">,
  overrides: Partial<UnmanagedSessionClientDeps> = {},
): UnmanagedSessionClientDeps {
  return {
    serverUrl: process.env.FALCON_SERVER_URL?.trim() || DEFAULT_SERVER_URL,
    fetchImpl: fetch,
    logger: noopLogger,
    ...required,
    ...overrides,
  };
}

/**
 * Upserts one unmanaged-session row. Best-effort: logs and resolves `false`
 * on any network/HTTP failure rather than throwing — a single failed upsert
 * must never crash the indexer's watch loop (design principle: no silent
 * failures, but also no crashing a background side channel over one bad
 * tick — matches `daemon/notify.ts`'s self-report contract).
 */
export async function upsertUnmanagedSession(
  deps: UnmanagedSessionClientDeps,
  params: UpsertUnmanagedSessionParams,
): Promise<boolean> {
  const dek = getRandomBytes(DEK_LENGTH_BYTES);
  const wrappedDek = wrapDek(dek, deps.contentPublicKey);
  const summaryBox = seal(params.summary, dek);

  try {
    const response = await deps.fetchImpl(`${deps.serverUrl}/v1/unmanaged-sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.token}`,
      },
      body: JSON.stringify({
        machineId: params.machineId,
        workspaceId: params.workspaceId,
        providerRef: params.providerRef,
        summary: summaryBox,
        dek: encodeBase64(wrappedDek),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      deps.logger.warn("[unmanaged-session-client] upsert rejected", {
        providerRef: params.providerRef,
        status: response.status,
        body,
      });
      return false;
    }
    return true;
  } catch (error) {
    deps.logger.warn("[unmanaged-session-client] upsert failed to reach server", {
      providerRef: params.providerRef,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
