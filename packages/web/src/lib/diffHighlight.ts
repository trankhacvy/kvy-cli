/**
 * Per-line shiki syntax highlighting for the unified diff viewer
 * (falcon-prd.md FR-7.7 "per-file unified diff view"; plan.md §16 "4.1 Git
 * panel"). Same shiki dependency `markdown.ts` already uses for fenced code
 * blocks (`theme: "github-dark"`, matching the app's single-theme-for-now
 * state — see that module's own doc comment) — reused here directly rather
 * than through the unified/remark/rehype pipeline, since diff content isn't
 * markdown.
 *
 * Returns shiki's own `ThemedToken[][]` (one array per line) instead of
 * pre-rendering to React or HTML — `UnifiedDiffViewer.tsx` turns each token
 * into a plain `<span>`, the same "compile to real elements, never
 * `dangerouslySetInnerHTML`" rule `markdown.ts` documents.
 */
import { type BundledLanguage, codeToTokens, type SpecialLanguage, type ThemedToken } from "shiki";

const THEME = "github-dark";

/** Extension → shiki bundled language id, covering the languages this codebase (and most web/backend projects) actually uses. Falls back to `"plaintext"` (no highlighting, still renders the text) for anything unmapped. */
const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  mdx: "mdx",
  css: "css",
  scss: "scss",
  html: "html",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  swift: "swift",
  graphql: "graphql",
  vue: "vue",
  prisma: "prisma",
  dockerfile: "docker",
};

/** Infers a shiki language id from a file path's extension — `"plaintext"` when unrecognized (extensionless files, unknown extensions). */
export function languageForPath(path: string): string {
  const lastSegment = path.split("/").pop() ?? path;
  const dotIndex = lastSegment.lastIndexOf(".");
  if (dotIndex <= 0) return "plaintext";
  const ext = lastSegment.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_LANGUAGES[ext] ?? "plaintext";
}

/** A line shiki couldn't tokenize renders as one unstyled token carrying its full text — highlighting is cosmetic, so a grammar-load failure (a language shiki doesn't bundle, or the code) must never hide the diff content itself. */
function plainTokens(lines: string[]): ThemedToken[][] {
  return lines.map((content) => [
    { content, offset: 0 } as ThemedToken,
  ]);
}

/**
 * Tokenizes `lines` (already-stripped diff line content, no `+`/`-`/` `
 * prefix) as `lang`, one token array per line. A single `codeToTokens` call
 * over the whole joined text (rather than one call per line) both
 * highlights faster and lets shiki's grammar track multi-line constructs
 * (e.g. a block comment spanning several diff lines) correctly.
 */
export async function highlightDiffLines(lines: string[], lang: string): Promise<ThemedToken[][]> {
  if (lines.length === 0) return [];
  const code = lines.join("\n");
  try {
    // `lang` is a plain `string` (the return type of `languageForPath`,
    // which any caller can also pass directly) rather than shiki's own
    // bundled-language union, so it's asserted here — an invalid id throws
    // inside `codeToTokens` and lands in the `catch` below exactly like any
    // other tokenization failure, falling back to unhighlighted text.
    const { tokens } = await codeToTokens(code, {
      lang: lang as BundledLanguage | SpecialLanguage,
      theme: THEME,
    });
    // shiki always returns one token row per input line, but guard the
    // (should-never-happen) mismatch defensively rather than let a caller
    // zip mismatched arrays silently.
    return tokens.length === lines.length ? tokens : plainTokens(lines);
  } catch {
    return plainTokens(lines);
  }
}
