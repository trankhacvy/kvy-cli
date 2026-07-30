/**
 * Pure logic for the "New project" flow (docs/web-ux-improvements-plan.md
 * Feature 4) — no React, no RPC, so it is unit-testable in a package whose
 * vitest runs `environment: "node"`. Same split as `inline-spawn.ts`/
 * `wizard-state.ts`/`file-tree-logic.ts`.
 *
 * WHY A FIXED BASE DIRECTORY: a genuine cross-platform filesystem browser is
 * a large piece of UI (and a mobile-hostile one). A single visible, boring
 * location the user can find in Finder/Explorer removes the need for it
 * entirely — the user names a folder, sees exactly where it will be, and
 * that's the whole decision.
 *
 * WHY NOT `~/.falcon/`: that directory is app state, not user data —
 * `workspace/registry.ts` keeps `workspaces.json` there, `runStateStore.ts`
 * keeps `run-state.json`, the CLI keeps `access.key`, and
 * `docs/uninstall.md` tells people to `rm -rf ~/.falcon` to uninstall.
 * Putting source code there would make uninstalling delete the user's work.
 */

/** The single, visible base directory every web-created project lands in, relative to the machine's home directory. */
export const WORKSPACE_BASE_DIR = "falcon-workspaces";

export type WorkspaceNameError =
  | "empty"
  | "has-separator"
  | "traversal"
  | "hidden"
  | "too-long"
  | "invalid-char";

/**
 * Validates a folder name as ONE safe path segment. Rejects anything that
 * could escape `~/falcon-workspaces/` or confuse a shell/filesystem. This is
 * defense in depth, not the security boundary: `fs.mkdir` requires an
 * absolute path (`fsBrowse.ts`) and `spawn` validates against the registry
 * (`workspacePath.ts`) — but an escaping name would produce a genuinely
 * wrong (if still authorized) directory, so it is caught here where the user
 * can actually fix it.
 */
export function validateWorkspaceName(raw: string): WorkspaceNameError | null {
  const name = raw.trim();
  if (name === "") return "empty";
  if (name.includes("/") || name.includes("\\")) return "has-separator";
  if (name === "." || name === ".." || name.includes("..")) return "traversal";
  if (name.startsWith(".")) return "hidden";
  if (name.length > 64) return "too-long";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL and control characters are exactly what this rejects.
  if (/[\u0000-\u001f<>:"|?*]/.test(name)) return "invalid-char";
  return null;
}

/** Plain-language message per error — no internal vocabulary (CLAUDE.md auth/UX rule #4). */
export const WORKSPACE_NAME_ERROR_COPY: Record<WorkspaceNameError, string> = {
  empty: "Give the project a name.",
  "has-separator": "Use just a name — no slashes.",
  traversal: "That name isn't allowed. Try something simpler.",
  hidden: "Names starting with a dot are hidden — pick another.",
  "too-long": "That name is too long.",
  "invalid-char": "That name has characters a folder can't use.",
};

/**
 * Builds the absolute path a named project will live at. `home` is the
 * machine's own home directory as the daemon reported it (`fs.list` with no
 * `path` returns `homedir()` and echoes the RESOLVED absolute path back —
 * `fsBrowse.ts` / `FsListResult.path`), never guessed client-side: the web
 * has no idea whether the machine is `/Users/x`, `/home/x` or `C:\Users\x`.
 *
 * Joined with `/` because every machine RPC path in this codebase is posix
 * (`git.files` returns posix-separated paths; `workspace/registry.ts` keys on
 * a posix real path). Windows support for this flow is an open question — see
 * this feature's rollout notes.
 */
export function buildWorkspacePath(home: string, name: string): string {
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  return `${base}/${WORKSPACE_BASE_DIR}/${name.trim()}`;
}

/** The `~`-abbreviated form to SHOW the user; the absolute form (`buildWorkspacePath`) is what's sent over the wire. Takes only `name` — the `~` abbreviation never depends on the machine's actual home path. */
export function displayWorkspacePath(name: string): string {
  return `~/${WORKSPACE_BASE_DIR}/${name.trim()}`;
}
