import { useMemo } from "react";
import type { RepoFileContent, RepoFilesActions, UseRepoFilesActions } from "./types";

/**
 * The Repo Files panel's default data source — mirrors `features/git-diff/
 * mock-source.ts`'s role: `apiSocket`/a live per-machine crypto client
 * aren't wired into a screen yet, so this simulates the daemon's
 * `git.files`/`fs.read` RPCs against a small fixed file tree, kept to the
 * same call signatures (`RepoFilesActions`) so swapping in the real
 * `machineRpcToRepoFilesActions` later is a one-line change at the call
 * site.
 */

const LATENCY_MS = 200;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MOCK_FILES: string[] = [
  "README.md",
  "package.json",
  "packages/web/src/features/repo-files/types.ts",
  "packages/web/src/features/repo-files/file-tree-logic.ts",
  "packages/web/src/features/repo-files/mock-source.ts",
  "packages/cli/src/daemon/gitFiles.ts",
  "packages/cli/src/daemon/fsRead.ts",
  "packages/wire/src/rpc.ts",
];

const MOCK_CONTENTS: Record<string, string> = {
  "README.md": "# Falcon\n\nRemote control for your coding agent sessions.\n",
  "package.json": '{\n  "name": "falcon",\n  "private": true\n}\n',
  "packages/web/src/features/repo-files/types.ts": [
    "export interface RepoFilesActions {",
    "  fetchFileList(worktree: string): Promise<string[]>;",
    "  fetchFileContent(worktree: string, path: string): Promise<unknown>;",
    "}",
    "",
  ].join("\n"),
  "packages/cli/src/daemon/gitFiles.ts": [
    "export async function getGitFiles(params, deps = {}) {",
    "  const git = deps.git ?? runGit;",
    '  const output = await git(["ls-files", "--cached", "--others", "--exclude-standard"], params.worktree);',
    "  return { files: output.split('\\n').filter(Boolean).sort() };",
    "}",
    "",
  ].join("\n"),
};

function defaultContentFor(path: string): string {
  return `// ${path}\n// (mock content — a live machine RPC hasn't been wired into this screen yet)\n`;
}

export function createMockRepoFilesActions(_machineId: string): RepoFilesActions {
  return {
    async fetchFileList(_worktree) {
      await delay(LATENCY_MS);
      return MOCK_FILES;
    },

    async fetchFileContent(_worktree, path): Promise<RepoFileContent> {
      await delay(LATENCY_MS);
      const inline = MOCK_CONTENTS[path] ?? defaultContentFor(path);
      return { inline, truncated: false };
    },
  };
}

/** `useMemo`'d on `machineId` so a real hook backed by a live `RepoFilesActions` client (which shouldn't reseal/reconnect every render) can be swapped in without changing this call site's shape. */
export const useMockRepoFilesActions: UseRepoFilesActions = (machineId) =>
  useMemo(() => createMockRepoFilesActions(machineId), [machineId]);
