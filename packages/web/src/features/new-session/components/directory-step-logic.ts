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
