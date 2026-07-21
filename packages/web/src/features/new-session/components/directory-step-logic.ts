/**
 * Pure logic split out of `directory-step.tsx` so it's unit-testable without
 * a React component-testing setup (this package's vitest config runs in the
 * `node` environment and only collects `*.test.ts`, not `.tsx` — see
 * `packages/web/vitest.config.ts`).
 *
 * Both the daemon's real `fs.list` RPC (`packages/cli/src/daemon/
 * fsBrowse.ts`'s `listDirectory`) and the mock filesystem
 * (`mock-source.ts`'s `browseDirectory`) throw the same
 * `"directory not found: <path>"` message shape for a path that doesn't
 * exist (as opposed to e.g. "path must be absolute" or a permission error),
 * so matching on that prefix reliably distinguishes "this path just hasn't
 * been created yet" (offer to use/create it anyway) from other browse
 * failures (nothing sensible to do but show the error).
 */
export function isDirectoryNotFoundError(message: string): boolean {
  return /directory not found/i.test(message);
}

/**
 * Non-authoritative client-side pre-check (plan.md §16 "Flow 3 —
 * spawn-directory-dedup" item 4): is `directory` one that already has a
 * live session, per the caller-supplied `liveDirectories` set (the synced
 * session list's `workspaceId` field, `packages/wire/src/rows.ts`'s
 * `SessionRow.workspaceId` — `live-actions.ts`'s own convention is that a
 * workspace's `workspaceId` *is* its directory path). This is racy across
 * devices — another device could spawn/stop a session in this exact
 * directory between this check and the actual submit — so it only ever
 * backs a non-blocking warning in `DirectoryStep`, never a hard block. The
 * daemon's own `spawn`-time dedup guard (`spawnEngine.ts`'s
 * `findLiveSessionInDirectory`) is the real, authoritative one; this is
 * purely a "heads up" earlier in the flow.
 */
export function isDirectoryAlreadyLive(directory: string, liveDirectories: string[]): boolean {
  return liveDirectories.includes(directory);
}
