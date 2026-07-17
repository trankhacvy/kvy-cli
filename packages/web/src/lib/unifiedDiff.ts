/**
 * Parses `git diff`'s unified diff text (the daemon `git.diff` RPC's
 * `inline` result, design §4.4; falcon-prd.md FR-7.7 "per-file unified diff
 * view") into a structured, per-line model the web diff viewer renders —
 * never via `dangerouslySetInnerHTML`, same principle as `markdown.ts`.
 *
 * Handles everything a single-`baseRef` `git diff` can emit: multiple files
 * per diff, added/deleted files (`--- /dev/null` / `+++ /dev/null`),
 * renames (present as a `diff --git a/old b/new` header even though this
 * MVP viewer doesn't special-case the rename itself — `git.status`'s own
 * `FileStatus.status: 'renamed'` already surfaces that), binary files (no
 * hunks, just a marker), and the trailing `\ No newline at end of file`
 * marker line.
 */

export type DiffLineType = "context" | "add" | "remove";

export interface UnifiedDiffLine {
  type: DiffLineType;
  content: string;
  /** 1-based line number in the old file; `null` for an added line. */
  oldLine: number | null;
  /** 1-based line number in the new file; `null` for a removed line. */
  newLine: number | null;
}

export interface UnifiedDiffHunk {
  /** The raw `@@ -a,b +c,d @@ ...` header line, kept for display. */
  header: string;
  lines: UnifiedDiffLine[];
}

export interface UnifiedDiffFile {
  /** Path with any `a/`/`b/` prefix stripped; `null` when the file didn't exist on that side (added/deleted). */
  oldPath: string | null;
  newPath: string | null;
  /** Display path — `newPath` unless the file was deleted, in which case `oldPath`. */
  path: string;
  binary: boolean;
  hunks: UnifiedDiffHunk[];
}

export interface ParsedUnifiedDiff {
  files: UnifiedDiffFile[];
}

const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;
const OLD_PATH_RE = /^--- (?:a\/(.+)|(\/dev\/null))$/;
const NEW_PATH_RE = /^\+\+\+ (?:b\/(.+)|(\/dev\/null))$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const BINARY_RE = /^Binary files (?:a\/(.+)|\/dev\/null) and (?:b\/(.+)|\/dev\/null) differ$/;

function pathOf(oldPath: string | null, newPath: string | null): string {
  if (newPath !== null) return newPath;
  if (oldPath !== null) return oldPath;
  return "(unknown file)";
}

/** Parses one `git diff` unified-diff blob into per-file, per-hunk, per-line structure. Malformed/unrecognized lines outside a hunk are ignored (extension headers like `index aaaa..bbbb 100644` this viewer has no use for); a genuinely empty `diffText` parses to `{files: []}`. */
export function parseUnifiedDiff(diffText: string): ParsedUnifiedDiff {
  const files: UnifiedDiffFile[] = [];
  let currentFile: UnifiedDiffFile | null = null;
  let currentHunk: UnifiedDiffHunk | null = null;
  let oldLineNo = 0;
  let newLineNo = 0;

  const lines = diffText.split("\n");

  for (const line of lines) {
    const gitHeader = DIFF_GIT_RE.exec(line);
    if (gitHeader) {
      const [, a, b] = gitHeader as unknown as [string, string, string];
      currentFile = { oldPath: a, newPath: b, path: pathOf(a, b), binary: false, hunks: [] };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (!currentFile) continue; // stray line before any `diff --git` header

    const binary = BINARY_RE.exec(line);
    if (binary) {
      currentFile.binary = true;
      continue;
    }

    const oldPathMatch = OLD_PATH_RE.exec(line);
    if (oldPathMatch) {
      currentFile.oldPath = oldPathMatch[1] ?? null;
      currentFile.path = pathOf(currentFile.oldPath, currentFile.newPath);
      continue;
    }

    const newPathMatch = NEW_PATH_RE.exec(line);
    if (newPathMatch) {
      currentFile.newPath = newPathMatch[1] ?? null;
      currentFile.path = pathOf(currentFile.oldPath, currentFile.newPath);
      continue;
    }

    const hunkHeader = HUNK_HEADER_RE.exec(line);
    if (hunkHeader) {
      const [, oldStart, , newStart] = hunkHeader as unknown as [
        string,
        string,
        string | undefined,
        string,
        string | undefined,
        string,
      ];
      oldLineNo = Number(oldStart);
      newLineNo = Number(newStart);
      currentHunk = { header: line, lines: [] };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue; // between file header and first hunk (e.g. mode-only change), or a line this parser doesn't model

    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    if (line.startsWith("+")) {
      currentHunk.lines.push({
        type: "add",
        content: line.slice(1),
        oldLine: null,
        newLine: newLineNo++,
      });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({
        type: "remove",
        content: line.slice(1),
        oldLine: oldLineNo++,
        newLine: null,
      });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({
        type: "context",
        content: line.slice(1),
        oldLine: oldLineNo++,
        newLine: newLineNo++,
      });
    }
    // Any other line shape inside a hunk — including a bare `""`, which is
    // never a real context line (`git diff` always prefixes even a blank
    // context line with a single space) and shows up here only as the
    // split-artifact of the diff text's own trailing newline — is silently
    // skipped rather than mis-typed as content. Better an incomplete hunk
    // than a wrong one.
  }

  return { files };
}
