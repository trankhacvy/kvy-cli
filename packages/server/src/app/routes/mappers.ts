import { encodeBase64 } from "@falcon/crypto";
import type {
  MachineRow,
  SessionRow,
  SessionStatus,
  UnmanagedSessionRow,
  WorkspaceRow,
} from "@falcon/wire";
import { decodeBox } from "../../db/box.js";
import type { machines, sessions, unmanagedSessions, workspaces } from "../../db/schema.js";

/** DB row → wire row for `SessionRowSchema` (design §6.1/§4.3). */
export function toSessionRow(row: typeof sessions.$inferSelect): SessionRow {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    machineId: row.machineId,
    tag: row.tag,
    provider: row.provider,
    executionTarget: row.executionTarget,
    status: row.status as SessionStatus,
    metadata: { value: decodeBox(row.metadata), version: row.metadataVersion },
    agentState: row.agentState
      ? { value: decodeBox(row.agentState), version: row.agentStateVersion }
      : null,
    dek: encodeBase64(row.dek),
    keyEpoch: row.keyEpoch,
    msgSeq: row.msgSeq,
    notificationsMuted: row.notificationsMuted,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * DB row → wire row for `MachineRowSchema`. `needsReauth` (AH8
 * "machine-status-reauth") is computed by the caller — `machineReauth.ts`'s
 * `computeMachinesNeedReauth`/`computeMachineNeedsReauth` — since it needs a
 * separate `device_sessions` query this pure mapper has no business owning;
 * defaults to `false` so a caller that hasn't computed it yet (there are
 * none left, but this keeps the function honest on its own) never reports a
 * false "needs re-auth".
 */
export function toMachineRow(row: typeof machines.$inferSelect, needsReauth = false): MachineRow {
  return {
    id: row.id,
    accountId: row.accountId,
    metadata: { value: decodeBox(row.metadata), version: row.metadataVersion },
    daemonState: row.daemonState
      ? { value: decodeBox(row.daemonState), version: row.daemonStateVersion }
      : null,
    dek: encodeBase64(row.dek),
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.getTime() : null,
    needsReauth,
  };
}

/** DB row → wire row for `WorkspaceRowSchema`. */
export function toWorkspaceRow(row: typeof workspaces.$inferSelect): WorkspaceRow {
  return {
    id: row.id,
    accountId: row.accountId,
    path: row.path,
    metadata: { value: decodeBox(row.metadata), version: row.metadataVersion },
    dek: encodeBase64(row.dek),
  };
}

/** DB row → wire row for `UnmanagedSessionRowSchema` (adoption Tier 1, FR-9.1). */
export function toUnmanagedSessionRow(
  row: typeof unmanagedSessions.$inferSelect,
): UnmanagedSessionRow {
  return {
    id: row.id,
    accountId: row.accountId,
    machineId: row.machineId,
    workspaceId: row.workspaceId,
    providerRef: row.providerRef,
    summary: decodeBox(row.summary),
    dek: encodeBase64(row.dek),
    updatedAt: row.updatedAt.getTime(),
  };
}
