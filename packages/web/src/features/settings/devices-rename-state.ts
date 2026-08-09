export type RenamingId = string | null;

export function startRename(sessionId: string): RenamingId {
  return sessionId;
}

export function cancelRename(): RenamingId {
  return null;
}

export function isRenaming(renamingId: RenamingId, sessionId: string): boolean {
  return renamingId === sessionId;
}
