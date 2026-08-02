/**
 * `RemoteModeDisplay` renders from. Verbatim structure; the one behavioral
 * `SDKMessage`/ACP log shape). Kvy's Ink display instead summarizes the
 * `SDKToEnvelope` converter output) — one source of truth for what the
 * remote-mode terminal shows and what the web timeline shows, rather than
 * re-deriving a second formatting of the raw SDK stream.
 */
import type { SessionEnvelope } from "@kvy/wire";

export type BufferedMessageKind = "user" | "assistant" | "system" | "tool" | "result" | "status";

export interface BufferedMessage {
  id: string;
  timestamp: Date;
  content: string;
  kind: BufferedMessageKind;
}

export class MessageBuffer {
  private messages: BufferedMessage[] = [];
  private listeners: Array<(messages: BufferedMessage[]) => void> = [];
  private nextId = 1;

  addMessage(content: string, kind: BufferedMessageKind = "assistant"): void {
    this.messages.push({ id: `msg-${this.nextId++}`, timestamp: new Date(), content, kind });
    this.notifyListeners();
  }

  getMessages(): BufferedMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
    this.nextId = 1;
    this.notifyListeners();
  }

  /** Returns an unsubscribe function. */
  onUpdate(listener: (messages: BufferedMessage[]) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) this.listeners.splice(index, 1);
    };
  }

  private notifyListeners(): void {
    const messages = this.getMessages();
    for (const listener of this.listeners) listener(messages);
  }
}

const TRUNCATE_AT = 400;

function truncate(text: string): string {
  return text.length > TRUNCATE_AT ? `${text.slice(0, TRUNCATE_AT)}... (truncated)` : text;
}

/**
 * for the remote-mode terminal. Returns `null` for envelopes with nothing
 * useful to show (e.g. bookkeeping-only turn markers).
 */
export function summarizeEnvelope(
  envelope: SessionEnvelope,
): { content: string; kind: BufferedMessageKind } | null {
  const ev = envelope.ev;

  switch (ev.t) {
    case "text":
      if (envelope.role === "user") return { content: `You: ${truncate(ev.md)}`, kind: "user" };
      return {
        content: ev.thinking ? `(thinking) ${truncate(ev.md)}` : `Claude: ${truncate(ev.md)}`,
        kind: "assistant",
      };
    case "service":
      return { content: ev.text, kind: "status" };
    case "tool-start":
      return { content: `🔧 ${ev.title ?? ev.name}`, kind: "tool" };
    case "tool-end":
      return { content: ev.ok ? "✅ done" : "❌ failed", kind: "tool" };
    case "file":
      return { content: `📎 ${ev.name}`, kind: "assistant" };
    case "turn-start":
      return null;
    case "turn-end":
      return ev.status === "completed" ? null : { content: `Turn ${ev.status}`, kind: "status" };
    case "perm-request":
      return { content: `🔒 Permission requested: ${ev.name}`, kind: "system" };
    case "perm-resolve":
      return { content: `🔓 Permission ${ev.decision.kind}`, kind: "system" };
    case "mode-switch":
      return { content: `↔ Switched to ${ev.control} control (${ev.by})`, kind: "status" };
    case "permission-mode":
      return { content: `🔀 Permission mode: ${ev.mode}`, kind: "status" };
    case "sub-start":
      return { content: "▶ Subagent started", kind: "status" };
    case "sub-stop":
      return { content: "⏹ Subagent finished", kind: "status" };
    case "usage":
      // line in this already-terse remote-mode terminal display.
      return null;
    case "plan":
      // Same reasoning as "usage" — the plan/todo list is a web-only
      // checklist widget, not worth a line here.
      return null;
  }
}

/** Convenience: summarizes and appends `envelope` to `buffer` in one call, if it produces a line. */
export function pushEnvelopeToBuffer(buffer: MessageBuffer, envelope: SessionEnvelope): void {
  const summary = summarizeEnvelope(envelope);
  if (summary) buffer.addMessage(summary.content, summary.kind);
}
