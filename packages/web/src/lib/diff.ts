export type DiffLineType = "context" | "add" | "remove";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/**
 * Line-level diff between two strings, computed via a classic LCS backtrack
 * (kvy-system-design.md §9.2 "diffs via ... a custom unified renderer").
 * This is a readable line diff, not a shortest-edit-script guarantee —
 * that's all the read-only `Edit`/`Write`/`MultiEdit` tool cards need.
 *
 * Falls back to a plain remove-all/add-all pair when the line-count product
 * would blow up the O(n*m) table — a huge generated file pasted into one
 * `Edit` call must never hang the tab (design principle: no silent hangs
 * either — this still renders every line, just without alignment).
 */
const MAX_LCS_CELLS = 4_000_000;

export function diffLines(oldText: string, newText: string): DiffLine[] {
  if (oldText === newText) {
    return splitLines(oldText).map((text) => ({ type: "context" as const, text }));
  }

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return [
      ...oldLines.map((text) => ({ type: "remove" as const, text })),
      ...newLines.map((text) => ({ type: "add" as const, text })),
    ];
  }

  const table = buildLcsTable(oldLines, newLines);
  return backtrack(oldLines, newLines, table);
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}

/** `table[i * cols + j]` = length of the LCS of `a[0..i)` and `b[0..j)`. */
function buildLcsTable(a: string[], b: string[]): Uint32Array {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cur = i * cols + j;
      if (a[i - 1] === b[j - 1]) {
        table[cur] = (table[(i - 1) * cols + (j - 1)] ?? 0) + 1;
      } else {
        const up = table[(i - 1) * cols + j] ?? 0;
        const left = table[i * cols + (j - 1)] ?? 0;
        table[cur] = Math.max(up, left);
      }
    }
  }

  return table;
}

function backtrack(a: string[], b: string[], table: Uint32Array): DiffLine[] {
  const cols = b.length + 1;
  const out: DiffLine[] = [];
  let i = a.length;
  let j = b.length;

  while (i > 0 || j > 0) {
    const aLine = a[i - 1];
    const bLine = b[j - 1];

    if (i > 0 && j > 0 && aLine === bLine) {
      out.push({ type: "context", text: aLine as string });
      i--;
      j--;
      continue;
    }

    const up = i > 0 ? (table[(i - 1) * cols + j] ?? 0) : -1;
    const left = j > 0 ? (table[i * cols + (j - 1)] ?? 0) : -1;

    if (j > 0 && left >= up) {
      out.push({ type: "add", text: bLine as string });
      j--;
    } else {
      out.push({ type: "remove", text: aLine as string });
      i--;
    }
  }

  out.reverse();
  return out;
}
