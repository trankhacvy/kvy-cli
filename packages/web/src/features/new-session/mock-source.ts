import { useMemo } from "react";
import type {
  DirectoryListing,
  ImportCandidate,
  NewSessionActions,
  NewSessionMachine,
  SpawnOutcome,
  UseNewSessionActions,
  UseNewSessionMachines,
} from "./types";

/**
 * The screen's default data source — mirrors `features/session-list/
 * mock-source.ts`'s role: `apiSocket`/a live per-machine crypto client
 * aren't wired into this screen yet, so this simulates the daemon's
 * `fs.list`/`fs.mkdir`/`spawn` RPCs against a small in-memory fake
 * filesystem, kept to the same call signatures (`UseNewSessionMachines`,
 * `UseNewSessionActions`) so swapping in the real hooks later is a one-line
 * change at the call site.
 */

const LATENCY_MS = 250;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MOCK_MACHINES: NewSessionMachine[] = [
  { id: "mach-laptop", name: "vy-macbook-pro", online: true },
  { id: "mach-server", name: "prod-build-box", online: false },
];

/** name → child directory names. Missing keys behave as "not created yet" — browsing them 404s the same way a real not-yet-existing directory would, and `spawn`ing into one triggers the create-directory approval loop. */
function seedFakeFs(): Map<string, string[]> {
  return new Map([
    ["/Users/vy", ["projects", "Documents", "Downloads"]],
    ["/Users/vy/projects", ["falcon", "happy", "scratch"]],
    ["/Users/vy/projects/falcon", []],
    ["/Users/vy/projects/happy", []],
    ["/Users/vy/projects/scratch", []],
    ["/Users/vy/Documents", []],
    ["/Users/vy/Downloads", []],
  ]);
}

/**
 * `directory` → simulated `adopt.list` candidates — only `/Users/vy/projects/falcon`
 * has any, so the import step's "no recent CLI sessions found here" empty
 * state is exercisable for every other seeded directory.
 */
const MOCK_IMPORT_CANDIDATES: Map<string, ImportCandidate[]> = new Map([
  [
    "/Users/vy/projects/falcon",
    [
      {
        providerSessionId: "prov-running-1",
        title: "Fix the flaky durability chaos test",
        lastActivityAt: Date.now() - 4 * 60_000,
        running: true,
      },
      {
        providerSessionId: "prov-finished-1",
        title: "Wire up the git diff panel",
        lastActivityAt: Date.now() - 2 * 60 * 60_000,
        running: false,
      },
    ],
  ],
]);

function parentOf(path: string): string | null {
  if (path === "/") return null;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

export function createMockNewSessionActions(_machineId: string): NewSessionActions {
  const fakeFs = seedFakeFs();

  return {
    async browseDirectory(path) {
      await delay(LATENCY_MS);
      const resolved = path ?? "/Users/vy";
      const children = fakeFs.get(resolved);
      if (!children) {
        throw new Error(`directory not found: ${resolved}`);
      }
      const listing: DirectoryListing = {
        path: resolved,
        parent: parentOf(resolved),
        entries: children
          .map((name) => ({ name, isDirectory: true }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
      return listing;
    },

    async createDirectory(path) {
      await delay(LATENCY_MS);
      if (!fakeFs.has(path)) {
        fakeFs.set(path, []);
        const parent = parentOf(path);
        if (parent) {
          const siblings = fakeFs.get(parent) ?? [];
          const base = path.slice(path.lastIndexOf("/") + 1);
          if (!siblings.includes(base)) {
            fakeFs.set(parent, [...siblings, base]);
          }
        }
      }
    },

    async registerWorkspace(directory) {
      // The mock fake-fs has no separate "registered workspaces" concept —
      // every seeded/created directory is already spawn-able (see `spawn`
      // below), so there's nothing for this mock to actually do; it exists
      // purely to satisfy `NewSessionActions`' shape for the mock source.
      await delay(LATENCY_MS);
      void directory;
    },

    async spawn(request) {
      await delay(LATENCY_MS);
      if (!fakeFs.has(request.directory)) {
        const outcome: SpawnOutcome = {
          type: "requiresApproval",
          action: "create-directory",
          directory: request.directory,
        };
        return outcome;
      }
      const outcome: SpawnOutcome = { type: "success", sessionId: `sess-${Date.now()}` };
      return outcome;
    },

    async listImportCandidates(directory) {
      await delay(LATENCY_MS);
      return MOCK_IMPORT_CANDIDATES.get(directory) ?? [];
    },
  };
}

/** `useMemo`'d on `machineId` so the fake filesystem's mutable state (created directories) survives re-renders — a real hook backed by a live `MachineRpcClient` will want the same memoization (avoid resealing/reconnecting every render), so this mirrors that shape rather than papering over it. */
export const useMockNewSessionActions: UseNewSessionActions = (machineId) =>
  useMemo(() => createMockNewSessionActions(machineId), [machineId]);

export const useMockNewSessionMachines: UseNewSessionMachines = () => MOCK_MACHINES;
