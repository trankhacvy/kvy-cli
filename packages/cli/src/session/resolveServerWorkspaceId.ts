import path from "node:path";
import { encodeBase64, getRandomBytes, hashWorkspacePath, seal, wrapDek } from "@kvy/crypto";
import { WorkspaceRowSchema } from "@kvy/wire";
import type { Logger } from "../logger.js";

const WORKSPACE_DEK_LENGTH_BYTES = 32;

export interface ResolveServerWorkspaceIdDeps {
  serverUrl: string;
  /** Injectable so unit tests never make a real network call. */
  fetchImpl: typeof fetch;
  getAuthToken: () => string | Promise<string>;
  /** Account's X25519 content public key — wraps the workspace's fresh DEK. */
  contentPublicKey: Uint8Array;
  workspaceIndexKey: Uint8Array;
  logger: Logger;
}

/**
 * Resolves the opaque `workspaces.id` the server should record as a
 * session's `workspaceId` — never `realPath` itself. Create-or-gets via
 * `POST /v1/workspaces`, keyed by `hashWorkspacePath(workspaceIndexKey,
 * realPath)` — an HMAC only this client can compute, so the server can dedup
 * workspaces by directory without ever learning what that directory is. The
 * real path travels only inside the sealed `metadata` box.
 *
 * Degrades to `null` on any failure (network, auth) rather than throwing —
 * same fallback shape as `registerSessionWorkspace`'s local bookkeeping call
 * — a session missing a workspace association is still fully usable.
 */
export async function resolveServerWorkspaceId(
  realPath: string,
  deps: ResolveServerWorkspaceIdDeps,
): Promise<string | null> {
  try {
    const pathHash = hashWorkspacePath(deps.workspaceIndexKey, realPath);
    const dek = getRandomBytes(WORKSPACE_DEK_LENGTH_BYTES);
    const wrappedDek = wrapDek(dek, deps.contentPublicKey);
    const metadataBox = seal({ path: realPath, displayName: path.basename(realPath) }, dek);

    const token = await deps.getAuthToken();
    const response = await deps.fetchImpl(`${deps.serverUrl}/v1/workspaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        pathHash,
        metadata: metadataBox,
        dek: encodeBase64(wrappedDek),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`POST /v1/workspaces responded ${response.status}: ${body}`);
    }

    const row = WorkspaceRowSchema.parse(await response.json());
    return row.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn("[resolve-server-workspace-id] failed, continuing without workspaceId", {
      message,
    });
    return null;
  }
}
