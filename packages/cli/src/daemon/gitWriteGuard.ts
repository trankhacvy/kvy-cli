/**
 * Worktree authorization for the *mutating* git machine RPCs
 * (`gitCommit.ts`/`gitPush.ts`/`gitRenameBranch.ts`, docs/features/
 * git-write-actions.md Phase 2; kvy-system-design.md §12: "no
 * arbitrary-directory execution from remote").
 *
 * `git.status`/`git.diff`/`git.branches` today run `git` in whatever
 * `worktree` the caller sends with NO validation against the workspace
 * registry (`workspace/registry.ts`) — for read-only ops that's a bounded
 * info-leak (an authenticated device can see the changed-files list / a
 * diff for an arbitrary directory on the machine), accepted as a known,
 * flagged gap rather than fixed here. For commit/push/force-push it's a
 * genuinely different risk — an authenticated device could otherwise run
 * real git *writes* in any directory on the machine, not just ones the
 * user actually designated as a Kvy workspace — so the mutating
 * handlers gate on `isWithinRegisteredWorkspace` before touching git at
 * all. Extending the read RPCs to the same gate is a deliberate follow-up,
 * not done here, so existing panels pointed at an unregistered worktree
 * (e.g. a directory picked before workspace registration existed) keep
 * working.
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
