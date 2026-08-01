/**
 * `commands.list` machine RPC handler ("/" slash-command autocomplete,
 * docs/competitive-notes-omnara.md #18): lists the project's *actual
 * custom* Claude Code slash commands, read live from `.claude/commands/`
 * in the session's worktree — not a fixed built-in list.
 *
 * Mirrors Claude Code's own convention: each `.md` file under
 * `.claude/commands/` is one command, named after its path relative to that
 * directory (extension stripped, subdirectories joined with `:` as a
 * namespace prefix — `.claude/commands/git/commit.md` -> `"git:commit"`).
 * `description`/`argument-hint` come from an optional leading YAML-ish
 * frontmatter block (`---\nkey: value\n---`), parsed by a tiny hand-rolled
 * scanner (`parseFrontMatter` below) rather than pulling in a YAML
 * dependency — these two flat string fields are the only ones this feature
 * needs, matching `fsBrowse.ts`'s own no-new-dependency style for a
 * `[quick]` feature.
 *
 * Unlike `fsBrowse.ts`'s `listDirectory` (which throws when the requested
 * directory doesn't exist), a missing `.claude/commands/` directory is the
 * *common* case here — most projects have no custom commands at all — so
 * it resolves to an empty list rather than an error. Any other read
 * failure on a subdirectory is treated the same way (best-effort listing,
 * never a hard failure for one bad entry) since this only backs an
 * autocomplete affordance, not a data-integrity-sensitive read.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SlashCommandInfo, SlashCommandsListParams, SlashCommandsListResult } from "@kvy/wire";

const COMMANDS_DIRNAME = path.join(".claude", "commands");
const COMMAND_EXTENSION = ".md";

/** The narrow slice of a `Dirent` this module needs — real `fs.Dirent` (from `readdir(..., {withFileTypes: true})`) satisfies this structurally, and tests can inject plain objects instead. */
export interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface SlashCommandsDeps {
  /** Injectable for tests; defaults to the real `fs.readdir(..., {withFileTypes: true})`. */
  readdir?: (dir: string) => Promise<DirentLike[]>;
  /** Injectable for tests; defaults to the real `fs.readFile(..., "utf8")`. */
  readFile?: (filePath: string) => Promise<string>;
}

interface FrontMatter {
  description?: string;
  argumentHint?: string;
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parses a leading `---\n...\n---` frontmatter block for `description`/
 * `argument-hint` only — a full YAML parser is unnecessary for these two
 * flat string fields. Returns `{}` when the file has no frontmatter block
 * (or the block has neither field), which is the common case for a
 * hand-written command file.
 */
export function parseFrontMatter(source: string): FrontMatter {
  if (!source.startsWith("---")) return {};
  const end = source.indexOf("\n---", 3);
  if (end === -1) return {};

  const result: FrontMatter = {};
  for (const line of source.slice(3, end).split("\n")) {
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1];
    const value = stripQuotes((match[2] ?? "").trim());
    if (!value) continue;
    if (key === "description") result.description = value;
    else if (key === "argument-hint") result.argumentHint = value;
  }
  return result;
}

/** Turns a `.claude/commands`-relative file path (e.g. `git/commit.md`) into its invocation name (`"git:commit"`) — subdirectories become a `:`-joined namespace prefix, matching Claude Code's own convention. */
export function commandNameFromRelativePath(relativePath: string): string {
  const withoutExtension = relativePath.slice(0, -COMMAND_EXTENSION.length);
  return withoutExtension.split(path.sep).join(":");
}

async function walkCommandsDir(
  deps: Required<SlashCommandsDeps>,
  root: string,
  dir: string,
): Promise<SlashCommandInfo[]> {
  let dirents: DirentLike[];
  try {
    dirents = await deps.readdir(dir);
  } catch {
    // Missing (or unreadable) directory — the common "no commands here"
    // case at the root, and a best-effort skip for any nested directory.
    return [];
  }

  const commands: SlashCommandInfo[] = [];
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      commands.push(...(await walkCommandsDir(deps, root, full)));
      continue;
    }
    if (!dirent.isFile() || !dirent.name.endsWith(COMMAND_EXTENSION)) continue;

    const name = commandNameFromRelativePath(path.relative(root, full));
    let frontMatter: FrontMatter = {};
    try {
      frontMatter = parseFrontMatter(await deps.readFile(full));
    } catch {
      // Unreadable file — still surface the command by name, just without
      // description/argument-hint metadata.
    }
    commands.push({ name, ...frontMatter });
  }
  return commands;
}

async function defaultReaddir(dir: string): Promise<DirentLike[]> {
  return readdir(dir, { withFileTypes: true });
}

async function defaultReadFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

/** Lists `params.worktree`'s `.claude/commands/` tree as `SlashCommandInfo[]`, sorted by name. Never throws — a missing directory (or any per-entry read failure) just yields fewer/no results. */
export async function listSlashCommands(
  params: SlashCommandsListParams,
  deps: SlashCommandsDeps = {},
): Promise<SlashCommandsListResult> {
  const resolvedDeps: Required<SlashCommandsDeps> = {
    readdir: deps.readdir ?? defaultReaddir,
    readFile: deps.readFile ?? defaultReadFile,
  };
  const commandsDir = path.join(params.worktree, COMMANDS_DIRNAME);
  const commands = await walkCommandsDir(resolvedDeps, commandsDir, commandsDir);
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return { commands };
}
