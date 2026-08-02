import type { UnmanagedActions } from "./types";

/** Safety cap so a daemon bug that never sets `done: true` throws instead of looping forever. */
const MAX_CHUNKS = 4096;

/**
 * Reads `providerSessionId`'s entire transcript by looping `actions.mirror`
 * from cursor `0` until the daemon reports `done: true`. Called fresh on every
 * poll rather than resuming from a prior cursor - the cursor is a pagination
 * offset into one read, not a tail/follow position.
 */
export async function fetchFullTranscript(
  actions: Pick<UnmanagedActions, "mirror">,
  providerSessionId: string,
): Promise<string> {
  let cursor: number | undefined;
  let text = "";
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const result = await actions.mirror(providerSessionId, cursor);
    text += result.chunk;
    if (result.done) return text;
    if (result.nextCursor === null) return text; // done:false but no next cursor — treat as end, don't loop forever
    cursor = result.nextCursor;
  }
  throw new Error(
    `transcript mirror for '${providerSessionId}' did not finish within ${MAX_CHUNKS} chunks`,
  );
}

/** One line of a rendered mirror — either a recognized Claude Code JSONL
 * entry's role + text, or the raw source line when it doesn't parse into
 * that shape (unrecognized entry types, mid-write partial lines, ...). */
export type MirrorLine = { kind: "user" | "agent"; text: string } | { kind: "raw"; text: string };

/** Extracts the first non-empty `text` block from a Claude Code
 * `message.content` field (string or block array) — same shape
 * `packages/cli/src/daemon/transcriptIndexer.ts`'s `extractText` reads,
 * duplicated here (rather than imported) because that module is
 * Node-only (`node:fs/promises`) and this one runs in the browser; the
 * parsing logic itself is a small, pure, self-contained function. */
function extractText(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || null;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        const text = ((block as Record<string, unknown>).text as string).trim();
        if (text) return text;
      }
    }
  }
  return null;
}

/**
 * Parses a Claude Code JSONL transcript into a readable line-per-turn feed
 * for the mirror view. Unparsable/unrecognized lines fall back to `{kind:
 * "raw"}` rather than being dropped (design principle: no silent data loss)
 * — a transcript is written incrementally by a live process, so a line
 * caught mid-write is expected, not an error.
 */
export function parseMirrorLines(transcript: string): MirrorLine[] {
  const lines: MirrorLine[] = [];
  for (const line of transcript.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      lines.push({ kind: "raw", text: trimmed });
      continue;
    }
    if (!raw || typeof raw !== "object") {
      lines.push({ kind: "raw", text: trimmed });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (entry.type === "user" || entry.type === "assistant") {
      const message = entry.message as Record<string, unknown> | undefined;
      const text = message ? extractText(message.content) : null;
      if (text) {
        lines.push({ kind: entry.type === "user" ? "user" : "agent", text });
        continue;
      }
    }
    lines.push({ kind: "raw", text: trimmed });
  }
  return lines;
}
