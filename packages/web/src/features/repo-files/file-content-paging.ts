/**
 * Pure byte-cursor paging logic for the file viewer's "Load more" affordance
 * (Feature 3 Phase 5, docs/web-ux-improvements-plan.md) — no React, no RPC,
 * same split as `push-readiness.ts`/`git-diff-query.ts`. `use-repo-files.ts`
 * calls `actions.fetchFileContent(worktree, path, range)` with
 * `range.start` set to the previous page's `loadedBytes` and appends the
 * result through `appendPage`.
 *
 * `fsRead.ts`'s daemon handler appends a human-readable
 * `"\n\n… (file truncated at N bytes)\n"` marker into the FIRST (no-range)
 * truncated response's own text — real content that would otherwise become
 * the last two "lines" of the file and inflate the line count once a proper
 * paging UI exists. `stripTruncationMarker` removes it client-side rather
 * than changing the daemon's wire behavior, which older web clients still
 * rely on as their only truncation signal.
 */

const TRUNCATION_MARKER_RE = /\n\n… \(file truncated at \d+ bytes\)\n$/;

/** Strips `fsRead.ts`'s inline truncation marker, if present. A no-op on any text that doesn't end with it (already-paged content never has one). */
export function stripTruncationMarker(text: string): string {
  return text.replace(TRUNCATION_MARKER_RE, "");
}

/** UTF-8 byte length — `fsRead.ts`'s `range` is a byte offset, not a character offset, and this app's file content can contain multi-byte characters. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface FileContentPage {
  /** `RepoFileContent.inline` from one `fs.read` call — possibly carrying the truncation marker (only ever on the first, no-range page). */
  inline: string | undefined;
  truncated: boolean;
}

export interface PagedFileContent {
  /** All pages' content concatenated, marker-stripped. */
  content: string;
  /** Cumulative UTF-8 byte length of `content` — the next page's `range.start`. */
  loadedBytes: number;
  /** `true` while the daemon reports more content exists beyond `loadedBytes`. */
  canLoadMore: boolean;
}

export const EMPTY_PAGED_CONTENT: PagedFileContent = {
  content: "",
  loadedBytes: 0,
  canLoadMore: false,
};

/**
 * Appends one fetched page onto `previous` (pass `null`/`EMPTY_PAGED_CONTENT`
 * for the first page of a freshly-selected file). A page shorter than
 * requested — or reporting `truncated: false` — ends pagination
 * (`canLoadMore: false`); the daemon's own `range` clamp
 * (`fsRead.ts`'s `maxInlineBytes`) means a request for more than one page's
 * worth back can itself come back marked truncated, so `canLoadMore` always
 * mirrors the page's own flag, never a client-side guess about size.
 */
export function appendPage(
  previous: PagedFileContent | null,
  page: FileContentPage,
): PagedFileContent {
  const base = previous ?? EMPTY_PAGED_CONTENT;
  const cleaned = stripTruncationMarker(page.inline ?? "");
  return {
    content: base.content + cleaned,
    loadedBytes: base.loadedBytes + byteLength(cleaned),
    canLoadMore: page.truncated,
  };
}
