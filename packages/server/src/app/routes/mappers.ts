import { encodeBase64 } from "@falcon/crypto";
import type { MachineRow, SessionRow, SessionStatus, UnmanagedSessionRow } from "@falcon/wire";
import { decodeBox } from "../../db/box.js";
import type { machines, sessions, unmanagedSessions } from "../../db/schema.js";

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
    msgSeq: row.msgSeq,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** DB row → wire row for `MachineRowSchema`. */
export function toMachineRow(row: typeof machines.$inferSelect): MachineRow {
  return {
    id: row.id,
    accountId: row.accountId,
    metadata: { value: decodeBox(row.metadata), version: row.metadataVersion },
    daemonState: row.daemonState
      ? { value: decodeBox(row.daemonState), version: row.daemonStateVersion }
      : null,
    dek: encodeBase64(row.dek),
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.getTime() : null,
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
