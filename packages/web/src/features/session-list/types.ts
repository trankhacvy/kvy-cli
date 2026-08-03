import type { Ephemeral, SessionRow } from "@kvy/wire";
import type { RenderItem } from "@/sync/reducer";
import type { MachineStatus } from "./use-machine-presence";

/**
 * the underlying wire row carries an `EncryptedBox` (`SessionRow.metadata`,
 * `MachineRow.metadata`) — the crypto bridge that produces that plaintext is
 * (`id`, `workspaceId`, `machineId`, `status`, `lastSeenAt`, ...) is a
 * pass-through of the plaintext routing metadata the server is allowed to
 */

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
  /** Pin/Unpin — lives in the encrypted metadata blob alongside `title`
   * (account-global, E2E
   * private: the server never learns which sessions a user pinned).
   * Defaults to `false` for a row that hasn't decrypted yet or never had the
   * field set, same as the CLI's `normalizeMetadata` treats a missing
   * `pinned` key as "not pinned" rather than "unknown". */
  pinned: boolean;
  /** This session's reduced transcript (`@kvy/web`'s sync reducer output)
   * — the event-stream input `deriveSessionStatus` walks to find an open
   * turn or an unresolved permission (design principle #3: derived, never
   * stored). `null` means "this session's message page hasn't decrypted /
   * been fetched yet this pass" — distinct from a resolved, genuinely empty
   * `[]` for a session with zero turns (same `null`-means-unknown precedent
   * as `title` above, Issue #13: `deriveSessionStatus` must not flash a
   * fabricated "ready" while decryption is still in flight — docs/known-
   * issues.md #9's own follow-up, since collapsing "not loaded" into the
   * same empty array as "genuinely new" just moves the mislabeling bug
   * rather than fixing it). */
  items: RenderItem[] | null;
  /** See `AttentionKind` — `null` when nothing is outstanding. */
  attention: AttentionKind | null;
}

export interface SessionListSnapshot {
  workspaces: SessionListWorkspace[];
  machines: SessionListMachine[];
  sessions: SessionListSession[];
  /** `true` while the initial `['sync']` account snapshot is still in
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
