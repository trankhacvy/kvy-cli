/**
 * Worktree authorization for the mutating git machine RPCs
 * (`gitCommit.ts`/`gitPush.ts`/`gitRenameBranch.ts`).
 *
 * Read-only RPCs (`git.status`/`git.diff`/`git.branches`) currently skip this
 * check - an authenticated device can read diffs for arbitrary directories,
 * which is a known flagged gap. Mutating ops gate on `isWithinRegisteredWorkspace`
 * because git writes in any directory is a real risk, not just an info-leak.
 */

import { isWithinRegisteredWorkspace, type RegistryOptions } from "../workspace/registry.js";
import { GitExecError } from "./gitExec.js";

/** Throws (a `GitExecError`) if `worktree` isn't authorized; resolves otherwise. Injectable seam for the write handlers below — same shape as their own `deps.git`. */
export type WorktreeAuthorizer = (worktree: string) => Promise<void>;

/** Builds a `WorktreeAuthorizer` backed by the real `workspace/registry.ts` store. `options` forwards straight through to `isWithinRegisteredWorkspace` (e.g. a test's overridden `homeDir`). */
export function createRegistryWorktreeAuthorizer(
  options: RegistryOptions = {},
): WorktreeAuthorizer {
  return async (worktree: string) => {
    const entry = await isWithinRegisteredWorkspace(worktree, options);
    if (entry === null) {
      throw new GitExecError(`worktree is not inside a registered workspace: ${worktree}`);
    }
  };
}
