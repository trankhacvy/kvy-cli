/**
 * Pulls a `--model <value>` (or `--model=value`) override out of a
 * passthrough args array (`falcon claude [args...]`/`falcon codex
 * [args...]`'s full flag passthrough, `CLAUDE.md`'s "CLI skeleton" bullet) —
 * used only to record the chosen model into the session's own metadata
 * (`session/bootstrap.ts`'s `SessionMetadataInput.model`) for the web
 * header's display-only model chip (plan-v2.md W4.2). The flag itself still
 * reaches the real `claude`/`codex` process unmodified, exactly as before —
 * this never rewrites or strips it from the args array, it only reads it.
 *
 * Last occurrence wins, matching how most CLIs resolve a repeated flag (a
 * later `--model` on the same command line overrides an earlier one).
 */
export function extractModelFlag(args: string[]): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--model") {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        found = value;
        i++;
      }
      continue;
    }
    if (arg.startsWith("--model=")) {
      found = arg.slice("--model=".length);
    }
  }
  return found;
}
