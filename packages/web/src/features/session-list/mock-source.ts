import { createEnvelope, type SessionEnvelope } from "@falcon/wire";
import { reduceEnvelopes } from "@/sync/reducer";
import type {
  SessionListMachine,
  SessionListSession,
  SessionListSnapshot,
  SessionListWorkspace,
  UseSessionListSnapshot,
} from "./types";

/**
 * The screen's default data source (plan.md 1.6 note: build against an
 * injectable/mock data source now, swap in the real sync-engine-backed hook
 * once `apiSocket` lands on `main` — same seam the sync-engine work uses for
 * `SyncSocketSource`). Every session's `items` here run through the real
 * `reduceEnvelopes`, not hand-built `RenderItem[]`, so this doubles as a
 * demonstration that `deriveSessionStatus` composes correctly with the
 * landed reducer, one fixture per FR-7.1 status.
 */

// Derived from the real clock at module-eval time (not a hardcoded absolute
// timestamp) so the relative offsets below stay meaningful whenever this
// fixture is loaded: `SessionCard` renders `session.updatedAt` through
// `formatRelativeTime`'s *real* `Date.now()` (no `now` override threaded
// through), so a pinned `NOW` drifts out of sync with wall-clock time and
// each fixture's intended "3m"/"2h"/etc. spread would otherwise collapse
// toward "just now" (or drift the other way) as real time moves past it.
const NOW = Date.now();
const MIN = 60_000;

/** `reduceEnvelopes`, given a shorthand name here since every fixture below
 * builds a session's `items` from raw envelopes through the real reducer. */
const turn = (events: SessionEnvelope[]) => reduceEnvelopes(events);

const workspaces: SessionListWorkspace[] = [
  { id: "w-falcon", name: "falcon" },
  { id: "w-happy", name: "happy" },
];

const machines: SessionListMachine[] = [
  { id: "m-laptop", name: "vy-macbook-pro", online: true },
  { id: "m-desktop", name: "vy-desktop", online: false },
];

const workingItems = turn([
  createEnvelope(
    "user",
    { t: "text", md: "Add the session list screen." },
    { time: NOW - 4 * MIN },
  ),
  createEnvelope("user", { t: "turn-start" }, { time: NOW - 4 * MIN }),
  createEnvelope(
    "agent",
    { t: "tool-start", call: "c1", name: "Read", args: { path: "packages/web/src/app/page.tsx" } },
    { time: NOW - 3 * MIN },
  ),
  createEnvelope(
    "agent",
    { t: "tool-end", call: "c1", ok: true, output: { lines: 18 } },
    { time: NOW - 3 * MIN + 5000 },
  ),
]);

const waitingForPermissionItems = turn([
  createEnvelope("user", { t: "turn-start" }, { time: NOW - 6 * MIN }),
  createEnvelope(
    "agent",
    {
      t: "perm-request",
      reqId: "r1",
      call: "c1",
      name: "Bash",
      args: { command: "pnpm dlx drizzle-kit push" },
      modes: ["default"],
    },
    { time: NOW - 5 * MIN },
  ),
  createEnvelope(
    "agent",
    { t: "tool-start", call: "c1", name: "Bash", args: { command: "pnpm dlx drizzle-kit push" } },
    { time: NOW - 5 * MIN },
  ),
]);

const idleItems = turn([
  createEnvelope("user", { t: "turn-start" }, { time: NOW - 40 * MIN }),
  createEnvelope(
    "agent",
    { t: "text", md: "Done — pushed the migration." },
    { time: NOW - 38 * MIN },
  ),
  createEnvelope("agent", { t: "turn-end", status: "completed" }, { time: NOW - 38 * MIN }),
]);

const completedItems = turn([
  createEnvelope("user", { t: "turn-start" }, { time: NOW - 60 * MIN }),
  createEnvelope("agent", { t: "text", md: "All tests pass." }, { time: NOW - 55 * MIN }),
  createEnvelope("agent", { t: "turn-end", status: "completed" }, { time: NOW - 55 * MIN }),
]);

const failedItems = turn([
  createEnvelope("user", { t: "turn-start" }, { time: NOW - 20 * MIN }),
  createEnvelope(
    "agent",
    { t: "tool-start", call: "c1", name: "Bash", args: { command: "pnpm build" } },
    { time: NOW - 19 * MIN },
  ),
  createEnvelope(
    "agent",
    { t: "tool-end", call: "c1", ok: false, output: { stderr: "type error" } },
    { time: NOW - 19 * MIN + 3000 },
  ),
  createEnvelope("agent", { t: "turn-end", status: "failed" }, { time: NOW - 18 * MIN }),
]);

const offlineItems = turn([
  createEnvelope("user", { t: "turn-start" }, { time: NOW - 3 * 60 * MIN }),
  createEnvelope(
    "agent",
    { t: "text", md: "Investigating the daemon crash." },
    { time: NOW - 2 * 60 * MIN },
  ),
]);

const sessions: SessionListSession[] = [
  {
    id: "s-working",
    workspaceId: "w-falcon",
    machineId: "m-laptop",
    title: "Session list (home) screen",
    provider: "claude",
    status: "active",
    updatedAt: NOW - 3 * MIN,
    items: workingItems,
    attention: null,
  },
  {
    id: "s-perm",
    workspaceId: "w-falcon",
    machineId: "m-laptop",
    title: "Drizzle schema migration",
    provider: "claude",
    status: "active",
    updatedAt: NOW - 5 * MIN,
    items: waitingForPermissionItems,
    attention: null,
  },
  {
    id: "s-question",
    workspaceId: "w-falcon",
    machineId: "m-laptop",
    title: "Push notification provider choice",
    provider: "codex",
    status: "active",
    updatedAt: NOW - 8 * MIN,
    items: turn([createEnvelope("user", { t: "turn-start" }, { time: NOW - 8 * MIN })]),
    attention: "question",
  },
  {
    id: "s-idle",
    workspaceId: "w-falcon",
    machineId: "m-laptop",
    title: "Rename the reducer test fixtures",
    provider: "claude",
    status: "active",
    updatedAt: NOW - 38 * MIN,
    items: idleItems,
    attention: null,
  },
  {
    id: "s-completed",
    workspaceId: "w-happy",
    machineId: "m-laptop",
    title: "Port the permission pipeline",
    provider: "claude",
    status: "active",
    updatedAt: NOW - 55 * MIN,
    items: completedItems,
    attention: "done",
  },
  {
    id: "s-failed",
    workspaceId: "w-happy",
    machineId: "m-laptop",
    title: "Fix the CI typecheck job",
    provider: "claude",
    status: "active",
    updatedAt: NOW - 18 * MIN,
    items: failedItems,
    attention: null,
  },
  {
    id: "s-offline",
    workspaceId: "w-happy",
    machineId: "m-desktop",
    title: "Debug the daemon singleton lock",
    provider: "claude",
    status: "active",
    updatedAt: NOW - 2 * 60 * MIN,
    items: offlineItems,
    attention: null,
  },
  {
    id: "s-archived",
    workspaceId: "w-happy",
    machineId: null,
    title: "Spike: sqlite vs postgres for self-host",
    provider: "claude",
    status: "archived",
    updatedAt: NOW - 26 * 60 * MIN,
    items: [],
    attention: null,
  },
];

const snapshot: SessionListSnapshot = { workspaces, machines, sessions };

/** Default `UseSessionListSnapshot` implementation — a static in-memory
 * fixture rather than a real hook (no live data to subscribe to yet), kept
 * to the same call signature so swapping in the real sync-engine-backed hook
 * later is a one-line change at the call site. */
export const useMockSessionListData: UseSessionListSnapshot = () => snapshot;
