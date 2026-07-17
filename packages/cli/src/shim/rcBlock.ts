/**
 * The single, clearly-marked PATH block `falcon shim install/uninstall`
 * ever touches inside a shell rc file (falcon-prd.md FR-9.6: "never modify
 * user rc files beyond the documented PATH block"). Pure string functions —
 * no filesystem I/O here — so the insert/remove logic is exhaustively unit
 * tested without ever touching a real rc file (see `install.ts`/
 * `uninstall.ts` for the I/O wrappers).
 */
import type { RcSyntax } from "./paths.js";

const BLOCK_START = "# >>> falcon shell shim >>>";
const BLOCK_END = "# <<< falcon shell shim <<<";

function pathExportLine(syntax: RcSyntax): string {
  return syntax === "fish"
    ? 'set -gx PATH "$HOME/.falcon/bin" $PATH'
    : 'export PATH="$HOME/.falcon/bin:$PATH"';
}

export function buildRcBlock(syntax: RcSyntax): string {
  return [BLOCK_START, pathExportLine(syntax), BLOCK_END].join("\n");
}

export function hasRcBlock(content: string): boolean {
  return content.includes(BLOCK_START);
}

/**
 * Appends the block, preceded by a blank line when the file already has
 * content. Idempotent: returns `content` unchanged if the block is already
 * present, so re-running install never duplicates it.
 */
export function insertRcBlock(content: string, syntax: RcSyntax): string {
  if (hasRcBlock(content)) return content;
  const trimmed = content.replace(/\n*$/, "");
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}${buildRcBlock(syntax)}\n`;
}

/**
 * Strips the marker block (plus one preceding blank line, so an
 * install→uninstall round trip restores the file exactly rather than
 * accumulating blank lines). Idempotent: returns `content` unchanged if no
 * block is present, or if the markers are malformed (start with no matching
 * end) — never guesses at a partial removal.
 */
export function removeRcBlock(content: string): string {
  const startIndex = content.indexOf(BLOCK_START);
  if (startIndex === -1) return content;

  const endMarkerIndex = content.indexOf(BLOCK_END, startIndex);
  if (endMarkerIndex === -1) return content;

  let removeEnd = endMarkerIndex + BLOCK_END.length;
  if (content[removeEnd] === "\n") removeEnd++;

  let removeStart = startIndex;
  if (content[removeStart - 1] === "\n" && content[removeStart - 2] === "\n") {
    removeStart--;
  }

  return content.slice(0, removeStart) + content.slice(removeEnd);
}
