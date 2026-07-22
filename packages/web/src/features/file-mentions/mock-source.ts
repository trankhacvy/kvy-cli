import { filterFileMentions } from "./fuzzy";
import type { FileMentionActions, FileMentionEntry } from "./types";

const LATENCY_MS = 80;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A representative slice of *this* repo's real files (falcon-prd.md's own
 * example set — "CLAUDE.md", "package.json" — plus enough breadth across
 * packages to make fuzzy matching worth demoing), not a live filesystem
 * listing — mirrors `features/git-diff/mock-source.ts`'s fixed small set
 * rather than dumping every tracked file. Swapped for
 * `createFsFileMentionActions(rpc, root)` (`live-actions.ts`) once a screen
 * has a live `apiSocket` + machine RPC client wired in.
 */
const MOCK_FILES: FileMentionEntry[] = [
  { path: "CLAUDE.md" },
  { path: "plan.md" },
  { path: "falcon-system-design.md" },
  { path: "falcon-prd.md" },
  { path: "package.json" },
  { path: "pnpm-workspace.yaml" },
  { path: "biome.json" },
  { path: "README.md" },
  { path: "docs/protocol.md" },
  { path: "docs/encryption.md" },
  { path: "docs/uninstall.md" },
  { path: "deploy/README.md" },
  { path: "deploy/docker-compose.yml" },
  { path: "packages/wire/src/rpc.ts" },
  { path: "packages/wire/src/index.ts" },
  { path: "packages/wire/package.json" },
  { path: "packages/crypto/src/index.ts" },
  { path: "packages/cli/src/daemon/machineRpc.ts" },
  { path: "packages/cli/src/daemon/gitDiff.ts" },
  { path: "packages/cli/src/daemon/gitStatus.ts" },
  { path: "packages/cli/src/commands/start.ts" },
  { path: "packages/cli/package.json" },
  { path: "packages/server/src/db/schema.ts" },
  { path: "packages/server/src/app/routes/push.ts" },
  { path: "packages/server/package.json" },
  { path: "packages/web/src/components/timeline/Composer.tsx" },
  { path: "packages/web/src/components/timeline/Timeline.tsx" },
  { path: "packages/web/src/features/git-diff/mock-source.ts" },
  { path: "packages/web/src/features/session-control/use-composer-state.ts" },
  { path: "packages/web/src/sync/machineRpc.ts" },
  { path: "packages/web/package.json" },
];

export const mockFileMentionActions: FileMentionActions = {
  async search(query) {
    await delay(LATENCY_MS);
    return filterFileMentions(MOCK_FILES, query);
  },
};
