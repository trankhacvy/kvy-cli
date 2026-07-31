import type { SessionEnvelope } from "@falcon/wire";

const SYSTEM_INSTRUCTION_RE = /^\s*<system_instruction>[\s\S]*?<\/system_instruction>\s*/i;
const MAX_TITLE_LENGTH = 120;

/**
 * The session's first genuine human-typed line — an auto-title fallback for
 * when Claude Code's own transcript `summary` line (`ptyClaudeSession.ts`'s
 * `onSummaryTitle`) hasn't shown up yet. In practice that summary line may
 * never show up at all (it's provider/version-dependent), so this fallback
 * is what actually replaces the folder-name title for most sessions; a later
 * summary (if one arrives) still overwrites it since both write with
 * `titleSource: "auto"`. Mirrors the same "strip the Conductor
 * `<system_instruction>` wrapper, take the first line" shape as the web's
 * own display-only `derive-fallback-title.ts`.
 */
export function deriveTitleFromFirstUserMessage(
  envelopes: readonly SessionEnvelope[],
): string | null {
  for (const envelope of envelopes) {
    if (envelope.role !== "user" || envelope.subagent) continue;
    if (envelope.ev.t !== "text" || envelope.ev.thinking) continue;
    const stripped = envelope.ev.md.replace(SYSTEM_INSTRUCTION_RE, "").trim();
    if (!stripped) continue;
    const firstLine = (stripped.split("\n")[0] ?? stripped).trim().replace(/\s+/g, " ");
    if (!firstLine) continue;
    return firstLine.length > MAX_TITLE_LENGTH
      ? `${firstLine.slice(0, MAX_TITLE_LENGTH - 1)}…`
      : firstLine;
  }
  return null;
}
