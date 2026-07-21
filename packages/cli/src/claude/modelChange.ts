import type { SessionEnvelope } from "@falcon/wire";

const ANSI_ESCAPE_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ORPHANED_ANSI_MARKER = /\[(?:\d+;)*\d+m/g;
const MODEL_CHANGE_PATTERN =
  /^Set model to\s+(.+?)(?:\s+and saved as your default for new sessions)?(?:\s+\[blocked\])?\.?$/i;

function normalizeTranscriptText(text: string): string {
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
    if (!envelope || envelope.role !== "agent" || envelope.ev.t !== "text" || envelope.ev.thinking) {
      continue;
    }
    const model = extractClaudeModelChangeFromText(envelope.ev.md);
    if (model) return model;
  }
  return null;
}
