import type { SessionRow } from "@falcon/wire";
import type { SessionMetadataPatch } from "@/lib/use-session-metadata-write";

/**
 * Pure logic behind `SessionCardActions`' menu-item enable/disable states
 * and mutation payloads, split out into its own module — same "pure state
 * lives in a plain module, directly testable without mounting anything"
 * precedent as `stop-session-state.ts` / `group.ts` — since this package's
 * `vitest.config.ts` has no jsdom/RTL setup to click a closed `DropdownMenu`
 * open in a test.
 */

/** A dead session (no process left to stop) is honestly disabled rather
 * than left clickable to fail with an opaque transport error. Archived
 * sessions are never actionable this way either — Restore is the only
 * lifecycle action available there (Phase 5). */
export function isSessionStoppable(status: SessionRow["status"]): boolean {
  return status !== "ended" && status !== "failed" && status !== "archived";
}

/** The Pin/Unpin menu item's functional patch — flips only `pinned`,
 * preserving every other key the CAS-retry core (`patchSessionMetadataCas`)
 * re-reads at write time (title, model, path, providerSessionId, …). */
export function buildPinTogglePatch(currentlyPinned: boolean): SessionMetadataPatch {
  return (current) => ({ ...current, pinned: !currentlyPinned });
}
