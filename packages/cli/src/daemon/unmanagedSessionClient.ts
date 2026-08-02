import { encodeBase64, getRandomBytes, seal, wrapDek } from "@kvy/crypto";
import type { Logger } from "../logger.js";

const DEK_LENGTH_BYTES = 32;
const DEFAULT_SERVER_URL = "http://127.0.0.1:3005";

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
  /** Resolves a fresh access token per call rather than a static string that could go stale. */
  getAccessToken: () => Promise<string | null>;
  /** Account's X25519 content public key — wraps the per-row DEK. */
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
  required: Pick<UnmanagedSessionClientDeps, "getAccessToken" | "contentPublicKey">,
  overrides: Partial<UnmanagedSessionClientDeps> = {},
): UnmanagedSessionClientDeps {
  return {
    serverUrl: process.env.KVY_SERVER_URL?.trim() || DEFAULT_SERVER_URL,
    fetchImpl: fetch,
    logger: noopLogger,
    ...required,
    ...overrides,
  };
}

/**
 * Upserts one unmanaged-session row. Logs and resolves `false` on any
 * network/HTTP failure rather than throwing — must never crash the watch loop.
 */
export async function upsertUnmanagedSession(
  deps: UnmanagedSessionClientDeps,
  params: UpsertUnmanagedSessionParams,
): Promise<boolean> {
  const dek = getRandomBytes(DEK_LENGTH_BYTES);
  const wrappedDek = wrapDek(dek, deps.contentPublicKey);
  const summaryBox = seal(params.summary, dek);

  try {
    const token = (await deps.getAccessToken()) ?? "";
    const response = await deps.fetchImpl(`${deps.serverUrl}/v1/unmanaged-sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
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
