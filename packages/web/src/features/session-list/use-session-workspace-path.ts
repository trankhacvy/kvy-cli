"use client";

import type { MachineRow, SessionRow } from "@kvy/wire";
import { useMemo } from "react";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";
import { useDecryptedTitles } from "./use-decrypted-titles";

const NO_SESSIONS: SessionRow[] = [];
const NO_MACHINES: MachineRow[] = [];

/**
 * The real absolute working-directory path for one session — decrypted from
 * `session.metadata` (never `session.workspaceId`, which is now an opaque
 * `workspaces.id`, not a path — see `use-decrypted-titles.ts`'s
 * `DecryptedSessionMeta.path`). `null` until decrypted, or if the row
 * predates this field, or decryption hasn't run yet (no live crypto bridge).
 */
export function useSessionWorkspacePath(session: SessionRow | undefined): string | null {
  const bridge = useCryptoBridge();
  const sessions = useMemo(() => (session ? [session] : NO_SESSIONS), [session]);
  const titles = useDecryptedTitles(sessions, NO_MACHINES, bridge);
  if (!session) return null;
  return titles.sessions.get(session.id)?.path ?? null;
}
