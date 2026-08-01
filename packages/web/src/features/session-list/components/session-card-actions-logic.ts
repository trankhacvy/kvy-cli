import type { SessionRow } from "@kvy/wire";
import type { SessionMetadataPatch } from "@/lib/use-session-metadata-write";
import { looksLikeWorktreePath } from "../worktree-path";

/**
 * Pure logic behind `SessionCardActions`'/`SessionActionsMenu`'s menu-item
 * states and the Archive flow's own gates, split out into its own module —
 * same "pure state lives in a plain module, directly testable without
 * mounting anything" precedent as `group.ts` — since this package's
 * `vitest.config.ts` has no jsdom/RTL setup to click a closed `DropdownMenu`
 * open in a test.
 */

/** Whether Archive should even attempt a `stop` RPC first — a dead session
 * (no process left to stop) skips straight to worktree cleanup instead of
 * failing with an opaque transport error. Archived sessions are never
 * stoppable either (there's nothing left to archive). */
export function isSessionStoppable(status: SessionRow["status"]): boolean {
  return status !== "ended" && status !== "failed" && status !== "archived";
}

/** The Pin/Unpin menu item's functional patch — flips only `pinned`,
 * preserving every other key the CAS-retry core (`patchSessionMetadataCas`)
 * re-reads at write time (title, model, path, providerSessionId, …). */
export function buildPinTogglePatch(currentlyPinned: boolean): SessionMetadataPatch {
  return (current) => ({ ...current, pinned: !currentlyPinned });
}

/** Whether Archive has an actual worktree to clean up: needs both a known
 * owning machine (the RPC is machine-scoped) AND a `workspaceId` that
 * actually looks like a Kvy-managed `.worktrees/<branch>` directory
 * (`worktree-path.ts`) — never attempted for an ordinary repo-root session,
 * where "removing the worktree" would be nonsensical (there isn't one) and,
 * if it somehow reached the RPC, unsafe. */
export function canOfferRemoveWorktree(
  machineId: string | null,
  workspaceId: string | null,
): boolean {
  return machineId !== null && looksLikeWorktreePath(workspaceId);
}
