import { useMemo } from "react";
import type {
  BranchItem,
  DirectoryListing,
  ImportCandidate,
  NewSessionActions,
  SpawnOutcome,
  UseNewSessionActions,
} from "./types";

/**
 * `NewSessionActions`' mock implementation — used by this package's own
 * unit tests (`__tests__/mock-source.test.ts`) and available for any future
 * standalone-review harness, mirroring `features/session-list/
 * mock-source.ts`'s role. Simulates the daemon's `fs.list`/`fs.mkdir`/
 * `spawn`/`adopt.list`/`git.branches` RPCs against a small in-memory fake
 * filesystem. The old wizard's machine-picker mock (`useMockNewSessionMachines`)
 * was retired alongside `MachineStep`/`DirectoryStep` (B5,
 * new-session-from-web redesign) — the workspace-row `+` flow always already
 * knows its machine (B1's `deriveDefaultTargetMachineId`), so there is no
 * machine-list step left to mock.
 */

const LATENCY_MS = 250;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

/**
 * `directory` → simulated `git.branches` result — only `/Users/vy/projects/falcon`
 * has any (same "not every seeded directory needs one" precedent as
 * `MOCK_IMPORT_CANDIDATES` above), and includes one `isCurrent` branch plus
 * one with `checkedOutAt` set so the existing-branch picker's disabled-row
 * UI is exercisable against the mock even before the real sync-engine
 * wiring lands.
 */
const MOCK_BRANCHES: Map<string, BranchItem[]> = new Map([
  [
    "/Users/vy/projects/falcon",
    [
      { name: "main", isCurrent: true, lastCommitAt: Math.floor(Date.now() / 1000) - 3_600 },
      {
        name: "wf/in-progress",
        isCurrent: false,
        checkedOutAt: "/Users/vy/projects/falcon/.worktrees/wf/in-progress",
        lastCommitAt: Math.floor(Date.now() / 1000) - 7_200,
      },
      {
        name: "wf/done-task",
        isCurrent: false,
        upstream: "origin/wf/done-task",
        lastCommitAt: Math.floor(Date.now() / 1000) - 86_400,
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

    async listBranches(directory) {
      await delay(LATENCY_MS);
      return MOCK_BRANCHES.get(directory) ?? [];
    },
  };
}

/** `useMemo`'d on `machineId` so the fake filesystem's mutable state (created directories) survives re-renders — a real hook backed by a live `MachineRpcClient` will want the same memoization (avoid resealing/reconnecting every render), so this mirrors that shape rather than papering over it. */
export const useMockNewSessionActions: UseNewSessionActions = (machineId) =>
  useMemo(() => createMockNewSessionActions(machineId), [machineId]);
