import type { SessionEnvelope } from "@kvy/wire";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches the real ESC control byte terminal ANSI escapes start with.
const ANSI_ESCAPE_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ORPHANED_ANSI_MARKER = /\[(?:\d+;)*\d+m/g;
const MODEL_CHANGE_PATTERN =
  /^Set model to\s+(.+?)(?:\s+and saved as your default for new sessions)?(?:\s+\[blocked\])?\.?$/i;

/**
 * Strips ANSI escape sequences/orphaned markers and collapses whitespace.
 * Exported so `envelopeMapper.ts` can reuse this exact cleaner for
 * local-command-stdout service text instead of duplicating ANSI-stripping
 * logic.
 */
export function normalizeTranscriptText(text: string): string {
  return text
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(ORPHANED_ANSI_MARKER, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripWrapping(value: string, left: string, right: string): string {
  return value.startsWith(left) && value.endsWith(right)
    ? value.slice(left.length, value.length - right.length).trim()
    : value;
}

function cleanModelLabel(label: string): string | null {
  let cleaned = normalizeTranscriptText(label);
  cleaned = stripWrapping(cleaned, "`", "`");
  cleaned = stripWrapping(cleaned, "**", "**");
  cleaned = stripWrapping(cleaned, '"', '"');
  cleaned = stripWrapping(cleaned, "[", "]");
  cleaned = cleaned.replace(/\s+\[blocked\]$/i, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function extractClaudeModelChangeFromText(text: string): string | null {
  const normalized = normalizeTranscriptText(text);
  const match = normalized.match(MODEL_CHANGE_PATTERN);
  if (!match) return null;
  const model = match[1];
  return model ? cleanModelLabel(model) : null;
}

export function findClaudeModelChangeInEnvelopes(
  envelopes: readonly SessionEnvelope[],
): string | null {
  for (let index = envelopes.length - 1; index >= 0; index -= 1) {
    const envelope = envelopes[index];
    if (envelope?.role !== "agent") continue;

    // Real assistant text (unchanged pre-existing case — a model-change
    // message that, for whatever reason, arrives as plain agent text rather
    // than the local-command-stdout wrapper).
    if (envelope.ev.t === "text" && !envelope.ev.thinking) {
      const model = extractClaudeModelChangeFromText(envelope.ev.md);
      if (model) return model;
      continue;
    }

    // `/model`'s real transcript shape is a `<local-command-stdout>` block,
    // which `envelopeMapper.ts` maps to a quiet `service` envelope (not
    // `text`) — this side channel has to look at the cleaned `service` text
    // too, or a model switch would stop updating the chip.
    if (envelope.ev.t === "service") {
      const model = extractClaudeModelChangeFromText(envelope.ev.text);
      if (model) return model;
    }
  }
  return null;
}
