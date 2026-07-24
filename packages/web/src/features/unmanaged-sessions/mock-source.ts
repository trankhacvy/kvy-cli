import type { SessionListMachine } from "@/features/session-list";
import type {
  AdoptMode,
  AdoptTakeOutcome,
  MirrorChunk,
  UnmanagedActions,
  UnmanagedSessionItem,
  UnmanagedSessionsSnapshot,
  UseUnmanagedActions,
  UseUnmanagedSessionsSnapshot,
} from "./types";

/**
 * The section's default data source (mirrors `features/session-list/
 * mock-source.ts`'s role — `apiSocket`/a live per-machine crypto client
 * aren't wired into this screen yet).
 */

const NOW = Date.now();
const MIN = 60_000;

const machines: SessionListMachine[] = [
  { id: "m-laptop", name: "vy-macbook-pro", online: true, status: "online" },
];

const sessions: UnmanagedSessionItem[] = [
  {
    id: "u-running",
    machineId: "m-laptop",
    workspaceId: "w-happy",
    providerRef: "prov-running-1",
    title: "Investigate the flaky push-notification test",
    lastActivityAt: NOW - 2 * MIN,
    running: true,
    updatedAt: NOW - 2 * MIN,
  },
  {
    id: "u-idle",
    machineId: "m-laptop",
    workspaceId: "w-falcon",
    providerRef: "prov-idle-1",
    title: "Quick fix for the CLI arg parser",
    lastActivityAt: NOW - 45 * MIN,
    running: false,
    updatedAt: NOW - 45 * MIN,
  },
];

const snapshot: UnmanagedSessionsSnapshot = { machines, sessions };

/** Default `UseUnmanagedSessionsSnapshot` implementation — a static
 * in-memory fixture, same seam as `useMockSessionListData`. */
export const useMockUnmanagedSessions: UseUnmanagedSessionsSnapshot = () => snapshot;

const LATENCY_MS = 250;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A small canned transcript, split into artificial ≤64KB-sized chunks the
 * same way `adopt.mirror`'s real chunking works, so the mirror view's
 * cursor-following logic is exercised against the mock too. */
const MOCK_TRANSCRIPT_LINES = [
  { type: "user", message: { content: "Can you look at the flaky test in push.test.ts?" } },
  { type: "assistant", message: { content: "Sure — reading the test file now." } },
  { type: "assistant", message: { content: "Found it: a race on the mock timer. Fixing." } },
];

function mockTranscriptText(): string {
  return MOCK_TRANSCRIPT_LINES.map((l) => JSON.stringify(l)).join("\n");
}

const CHUNK_SIZE = 40;

function createMockActions(providerRefs: Set<string>): UnmanagedActions {
  return {
    async mirror(providerSessionId, cursor): Promise<MirrorChunk> {
      await delay(LATENCY_MS);
      if (!providerRefs.has(providerSessionId)) {
        throw new Error(`unknown unmanaged session: ${providerSessionId}`);
      }
      const text = mockTranscriptText();
      const start = cursor ?? 0;
      const end = Math.min(start + CHUNK_SIZE, text.length);
      const chunk = text.slice(start, end);
      const done = end >= text.length;
      return { chunk, nextCursor: done ? null : end, done };
    },

    async take(providerSessionId, mode: AdoptMode): Promise<AdoptTakeOutcome> {
      await delay(LATENCY_MS * 2);
      if (!providerRefs.has(providerSessionId)) {
        throw new Error(`unknown unmanaged session: ${providerSessionId}`);
      }
      const session = sessions.find((s) => s.providerRef === providerSessionId);
      const outcome: AdoptTakeOutcome = { sessionId: `mock-adopted-${providerSessionId}` };
      if (mode === "takeover" && session?.running) {
        outcome.warning = "The original session was mid-turn — it was interrupted.";
      }
      return outcome;
    },
  };
}

/** Default `UseUnmanagedActions` implementation — same call signature as
 * `machineRpcToUnmanagedActions`, so swapping the real thing in later is a
 * one-line change at the call site. */
export const useMockUnmanagedActions: UseUnmanagedActions = (_machineId: string) =>
  createMockActions(new Set(sessions.map((s) => s.providerRef)));
