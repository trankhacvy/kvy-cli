import type { Ephemeral, SessionRow } from "@falcon/wire";
import type { RenderItem } from "@/sync/reducer";
import type { MachineStatus } from "./use-machine-presence";

/**
 * View-model types for the Home / session-list screen (design §9.2 "Home"
 * row, falcon-prd.md FR-7.1). Field values here are already decrypted where
 * the underlying wire row carries an `EncryptedBox` (`SessionRow.metadata`,
 * `MachineRow.metadata`) — the crypto bridge that produces that plaintext is
 * a separate, not-yet-landed concern (design §5.3). Everything else
 * (`id`, `workspaceId`, `machineId`, `status`, `lastSeenAt`, ...) is a
 * pass-through of the plaintext routing metadata the server is allowed to
 * see (design §5.3 "what the server can see").
 */

/** The server-computed, never-persisted signal for a session (design §4.3
 * `Ephemeral` union, `t: "attention"`) — the one status input that isn't
 * recoverable by replaying `RenderItem[]` alone, since the wire's
 * `SessionEvent` union has no "agent asked a question" variant yet
 * (falcon-prd.md FR-8.1/FR-8.2 leave that inference to the session process).
 * `null` means "no outstanding attention signal for this session". */
export type AttentionKind = Extract<Ephemeral, { t: "attention" }>["kind"];

export interface SessionListWorkspace {
  id: string;
  /** Decrypted workspace name (e.g. the directory basename). */
  name: string;
}

export interface SessionListMachine {
  id: string;
  /** Decrypted machine name (e.g. hostname). `null` means "not decrypted
   * yet" — distinct from a genuinely empty/unnamed machine, which is a
   * resolved placeholder string (Issue #13: don't flash a placeholder while
   * decryption is still in flight). */
  name: string | null;
  /** Live presence (design §4.3 `machine-presence` ephemeral / `lastSeenAt`
   * heartbeat) — never persisted as a flag, always a snapshot of "right now".
   * Kept alongside `status` (AH8 "machine-status-reauth") rather than
   * replaced by it — every existing consumer (restart-eligibility checks,
   * the per-session "offline" status dot) only ever needed "is the machine
   * reachable", a strictly boolean question `status`'s extra "why" doesn't
   * change the answer to. */
  online: boolean;
  /** The Home screen's machine badge status (`use-machine-presence.ts`'s
   * `deriveMachineStatus`) — distinguishes "needs re-authentication" (a
   * daemon that's running but whose refresh token was revoked) from plain
   * `offline` (powered off/asleep), which `online: boolean` alone can't. */
  status: MachineStatus;
}

export interface SessionListSession {
  id: string;
  workspaceId: string | null;
  machineId: string | null;
  /** Decrypted session title. `null` means "not decrypted yet" — distinct
   * from a genuinely untitled session, which is a resolved placeholder
   * string (Issue #13: don't flash a placeholder while decryption is still
   * in flight). */
  title: string | null;
  provider: string;
  status: SessionRow["status"];
  updatedAt: number;
  /** Pin/Unpin (docs/features/session-lifecycle-actions.md Phase 4) — lives
   * in the encrypted metadata blob alongside `title` (account-global, E2E
   * private: the server never learns which sessions a user pinned).
   * Defaults to `false` for a row that hasn't decrypted yet or never had the
   * field set, same as the CLI's `normalizeMetadata` treats a missing
   * `pinned` key as "not pinned" rather than "unknown". */
  pinned: boolean;
  /** This session's reduced transcript (`@falcon/web`'s sync reducer output)
   * — the event-stream input `deriveSessionStatus` walks to find an open
   * turn or an unresolved permission (design principle #3: derived, never
   * stored). Empty for a session with no messages yet. */
  items: RenderItem[];
  /** See `AttentionKind` — `null` when nothing is outstanding. */
  attention: AttentionKind | null;
}

export interface SessionListSnapshot {
  workspaces: SessionListWorkspace[];
  machines: SessionListMachine[];
  sessions: SessionListSession[];
  /** `true` while the initial `['sync']` account snapshot is still in
   * flight and nothing has ever landed in cache yet (plan-v2.md W4.2
   * "skeletons for Home … initial loads") — optional and defaulted to
   * `false`-ish (`undefined`) by every fixture source (`mock-source.ts`,
   * `buildSnapshot` in tests) that has no async loading phase to model. */
  isLoading?: boolean;
}

/**
 * Injectable data source for the screen — mirrors the pattern the (unlanded)
 * sync-engine work uses for `SyncSocketSource`: a narrow, structurally-typed
 * seam so the screen is buildable and testable before `apiSocket`/the sync
 * engine land on `main`. A real hook backed by TanStack Query + the sync
 * engine satisfies this signature with no adapter needed once it exists.
 */
export type UseSessionListSnapshot = () => SessionListSnapshot;
