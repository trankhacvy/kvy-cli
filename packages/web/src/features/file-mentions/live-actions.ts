import type { MachineRpcClient } from "@/sync/machineRpc";
import { filterFileMentions } from "./fuzzy";
import type { FileMentionActions, FileMentionEntry } from "./types";

/**
 * Directory names never descended into — build output, VCS internals, and
 * dependency trees that would otherwise dwarf a repo's own files and burn
 * the traversal budget below before it ever reaches real source. Every
 * other dot-directory (`.vscode`, `.github`, ...) is skipped too, via the
 * plain `startsWith(".")` check in `collectFiles` below.
 */
const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  ".next",
  ".turbo",
  "coverage",
  ".worktrees",
]);

/** Hard ceiling on how many `fs.list` round-trips one search does — bounds
 * both latency and the daemon-side directory-scan cost for a single
 * keystroke. Generous enough to cover this monorepo's package tree in one
 * pass; a repo bigger than that gets a partial (but never a hung) result. */
const MAX_DIRECTORIES_VISITED = 200;
/** Hard ceiling on how many files a single search collects before it stops descending further — same reasoning as the directory cap. */
const MAX_FILES_COLLECTED = 5000;

/**
 * Adapts a `MachineRpcClient` to `FileMentionActions` via the existing
 * `fs.list` RPC (`features/new-session`'s directory picker,
 * `@falcon/wire`'s `FsListParamsSchema`) — there's no dedicated "search
 * files" RPC, so this does its own bounded breadth-first walk of `root`,
 * then fuzzy-filters the collected paths client-side (`fuzzy.ts`) exactly
 * like `mock-source.ts` does over its fixed set. Mirrors
 * `features/git-diff/live-actions.ts`'s one-seam-swap role — not wired into
 * a live screen yet (no live `apiSocket`/crypto client anywhere in this app,
 * same as every other `features/*` live-actions module).
 */
export function createFsFileMentionActions(
  rpc: MachineRpcClient,
  root: string,
): FileMentionActions {
  return {
    async search(query) {
      const files = await collectFiles(rpc, root);
      return filterFileMentions(files, query);
    },
  };
}

async function collectFiles(rpc: MachineRpcClient, root: string): Promise<FileMentionEntry[]> {
  const files: FileMentionEntry[] = [];
  const queue: string[] = [root];
  let visited = 0;

  while (
    queue.length > 0 &&
    visited < MAX_DIRECTORIES_VISITED &&
    files.length < MAX_FILES_COLLECTED
  ) {
    const dir = queue.shift();
    if (dir === undefined) break;
    visited++;

    let listing: import("@falcon/wire").FsListResult;
    try {
      listing = await rpc.call("fs.list", {
        idempotencyKey: crypto.randomUUID(),
        path: dir,
      });
    } catch {
      continue; // an unreadable/removed directory just yields fewer results, not a failed search
    }

    for (const entry of listing.entries) {
      const entryPath = `${listing.path.replace(/\/$/, "")}/${entry.name}`;
      if (entry.isDirectory) {
        if (!IGNORED_DIR_NAMES.has(entry.name) && !entry.name.startsWith(".")) {
          queue.push(entryPath);
        }
        continue;
      }
      files.push({ path: relativeToRoot(entryPath, root) });
    }
  }

  return files;
}

function relativeToRoot(path: string, root: string): string {
  const normalizedRoot = root.replace(/\/$/, "");
  return path.startsWith(`${normalizedRoot}/`) ? path.slice(normalizedRoot.length + 1) : path;
}
