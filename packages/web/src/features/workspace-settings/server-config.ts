import { decodeBase64 } from "@kvy/crypto/web";
import type { WorkspaceRow } from "@kvy/wire";
import type { CryptoBridgeClient } from "@/crypto";
import type {
  createWorkspace as createWorkspaceDefault,
  putWorkspaceMetadataCas as putWorkspaceMetadataCasDefault,
} from "@/lib/api";
import type { WorkspaceGitConfig } from "./types.js";

/**
 * Server-synced counterpart to `WorkspaceSettingsActions.setConfig` — writes
 * `baseRef`/`remote` to the `workspaces` table (design conversation: "why
 * don't we store this centrally too") so the dialog can read/edit it even
 * when the daemon is offline, and so it's a single source of truth across
 * every machine that's checked the workspace out. The create-or-get key is
 * `hashWorkspacePath(path)` (same idempotency shape as `sessions`' `tag`) —
 * never the raw path, which the server must never see; the real path travels
 * only inside the sealed `metadata` box below.
 *
 * Unlike `use-session-metadata-write.ts`'s session-scoped CAS write (always
 * against an existing row), a workspace may have no server-side row yet —
 * the CLI never mints one, only the web dialog does, lazily, on first save.
 * That's the one branch this module adds beyond `patchSessionMetadataCas`'s
 * shape: no existing row means `bridge.createDek()` mints a fresh one instead
 * of `setSessionKey()`+CAS-retry against an existing row.
 */
export type WorkspaceServerConfigPatch = (current: WorkspaceGitConfig) => WorkspaceGitConfig;

const MAX_ATTEMPTS = 5;

export async function saveWorkspaceServerConfig(
  deps: {
    bridge: CryptoBridgeClient;
    createWorkspace: typeof createWorkspaceDefault;
    putMetadataCas: typeof putWorkspaceMetadataCasDefault;
    token: string;
    path: string;
  },
  existing: WorkspaceRow | undefined,
  patch: WorkspaceServerConfigPatch,
): Promise<WorkspaceRow> {
  if (!existing) {
    // The real path is sealed into `metadata` alongside the git config (never
    // sent to the server in the clear) — a freshly-created-by-web workspace
    // row still needs it for the same reasons the CLI's own workspace rows do.
    const initial = { ...patch({}), path: deps.path };
    const { wrappedDek, box } = await deps.bridge.createDek(initial);
    const pathHash = await deps.bridge.hashWorkspacePath(deps.path);
    return deps.createWorkspace(deps.token, { pathHash, metadata: box, dek: wrappedDek });
  }

  const unwrapped = await deps.bridge.setSessionKey(decodeBase64(existing.dek));
  if (!unwrapped) {
    throw new Error("Could not unwrap this workspace's key.");
  }

  let current = existing.metadata;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const opened = await deps.bridge.open<WorkspaceGitConfig>(current.value);
    if (!opened) {
      throw new Error("Could not decrypt this workspace's config.");
    }
    const patched = patch(opened);
    const sealed = await deps.bridge.seal(patched);
    const result = await deps.putMetadataCas(deps.token, existing.id, {
      expectedVersion: current.version,
      value: sealed,
    });
    if (result.ok) {
      return { ...existing, metadata: { value: sealed, version: result.version } };
    }
    current = result.current;
  }
  throw new Error("Could not save: too many conflicting writes. Try again.");
}
