import {
  type CreateEnvelopeOptions,
  createEnvelope,
  type SessionEnvelope,
  type SessionEvent,
  type SessionRole,
} from "@kvy/wire";
import { createId } from "@paralleldrive/cuid2";
import { normalizeTranscriptText } from "./modelChange.js";
import type { RawJSONLines } from "./types.js";

/** `@kvy/wire` doesn't export this narrowed type on its own — derive it. */
export type SessionTurnEndStatus = Extract<SessionEvent, { t: "turn-end" }>["status"];

/**
 * Mutable, per-session mapper state. Only `currentTurnId` is required;
 * every other field is an internal, lazily-created map/set. Tests can
 * construct plain `{ currentTurnId: null }` literals without a factory.
 */
export interface ClaudeEnvelopeMapperState {
  currentTurnId: string | null;
  uuidToProviderSubagent?: Map<string, string>;
  taskPromptToProviderSubagents?: Map<string, string[]>;
  providerCallIds?: Map<string, string>;
  providerSubagentIds?: Map<string, string>;
  bufferedSubagentMessages?: Map<string, RawJSONLines[]>;
  hiddenParentToolCalls?: Set<string>;
  startedSubagents?: Set<string>;
  activeSubagents?: Set<string>;
}

export function createClaudeEnvelopeMapperState(): ClaudeEnvelopeMapperState {
  return { currentTurnId: null };
}

// --- lazy accessors for the optional state maps/sets ---

function uuidToProviderSubagent(state: ClaudeEnvelopeMapperState): Map<string, string> {
  if (!state.uuidToProviderSubagent) state.uuidToProviderSubagent = new Map();
  return state.uuidToProviderSubagent;
}

function taskPromptToProviderSubagents(state: ClaudeEnvelopeMapperState): Map<string, string[]> {
  if (!state.taskPromptToProviderSubagents) state.taskPromptToProviderSubagents = new Map();
  return state.taskPromptToProviderSubagents;
}

function providerCallIds(state: ClaudeEnvelopeMapperState): Map<string, string> {
  if (!state.providerCallIds) state.providerCallIds = new Map();
  return state.providerCallIds;
}

function providerSubagentIds(state: ClaudeEnvelopeMapperState): Map<string, string> {
  if (!state.providerSubagentIds) state.providerSubagentIds = new Map();
  return state.providerSubagentIds;
}

function bufferedSubagentMessages(state: ClaudeEnvelopeMapperState): Map<string, RawJSONLines[]> {
  if (!state.bufferedSubagentMessages) state.bufferedSubagentMessages = new Map();
  return state.bufferedSubagentMessages;
}

function hiddenParentToolCalls(state: ClaudeEnvelopeMapperState): Set<string> {
  if (!state.hiddenParentToolCalls) state.hiddenParentToolCalls = new Set();
  return state.hiddenParentToolCalls;
}

function startedSubagents(state: ClaudeEnvelopeMapperState): Set<string> {
  if (!state.startedSubagents) state.startedSubagents = new Set();
  return state.startedSubagents;
}

function activeSubagents(state: ClaudeEnvelopeMapperState): Set<string> {
  if (!state.activeSubagents) state.activeSubagents = new Set();
  return state.activeSubagents;
}

// --- provider-id -> cuid2 mapping ---

/** Mints a cuid2 for a provider id the first time it's seen; stable after. */
function mintedId(map: Map<string, string>, providerId: string): string {
  const existing = map.get(providerId);
  if (existing) return existing;
  const minted = createId();
  map.set(providerId, minted);
  return minted;
}

/** Looks up an already-minted subagent cuid2 without minting a new one. */
function lookupSubagentId(
  state: ClaudeEnvelopeMapperState,
  providerSubagent: string,
): string | undefined {
  return providerSubagentIds(state).get(providerSubagent);
}

// --- narrow accessors onto the passthrough'd raw JSONL shape ---
// `RawJSONLinesSchema` (types.ts) deliberately validates only the dedup-key
// fields; everything else — `message.*`, `parentUuid`, `isSidechain`,
// `parent_tool_use_id` — is real at runtime (Claude Code writes it) but
// `pickUuid`/`pickParentUuid`-style helpers.

interface RawTextBlock {
  type: "text";
  text?: unknown;
}
interface RawThinkingBlock {
  type: "thinking";
  thinking?: unknown;
}
interface RawToolUseBlock {
  type: "tool_use";
  id?: unknown;
  name?: unknown;
  input?: unknown;
}
interface RawToolResultBlock {
  type: "tool_result";
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}
/** An image content block — user-pasted images and tool results (e.g. `Read` on an image file) both use this shape. */
interface RawImageBlock {
  type: "image";
  source?: unknown;
}
type RawContentBlock =
  | RawTextBlock
  | RawThinkingBlock
  | RawToolUseBlock
  | RawToolResultBlock
  | RawImageBlock
  | { type: unknown };

function pickUuid(message: RawJSONLines): string | undefined {
  const raw = message as unknown as { uuid?: unknown };
  return typeof raw.uuid === "string" && raw.uuid.length > 0 ? raw.uuid : undefined;
}

function pickParentUuid(message: RawJSONLines): string | undefined {
  const raw = message as unknown as { parentUuid?: unknown; parentUUID?: unknown };
  if (typeof raw.parentUuid === "string" && raw.parentUuid.length > 0) return raw.parentUuid;
  if (typeof raw.parentUUID === "string" && raw.parentUUID.length > 0) return raw.parentUUID;
  return undefined;
}

function isSidechainMessage(message: RawJSONLines): boolean {
  return (message as unknown as { isSidechain?: unknown }).isSidechain === true;
}

function isMetaMessage(message: RawJSONLines): boolean {
  return (message as unknown as { isMeta?: unknown }).isMeta === true;
}

function isCompactSummaryMessage(message: RawJSONLines): boolean {
  return (message as unknown as { isCompactSummary?: unknown }).isCompactSummary === true;
}

// BF1.2 (bug-fix-plan.md #4): Claude Code records a local slash command
// (e.g. `/model haiku`) as a synthetic `user`-type record wrapped in its own
// XML-ish tags — the invocation as `<command-name>...</command-name>` (plus
// a sibling `<command-message>`), and the result as a later `user` record
// wrapped in `<local-command-stdout>...</local-command-stdout>`. Neither
// wrapper is a real chat turn, so both get quiet handling below instead of
// flowing through as a raw-tagged chat bubble.
const LOCAL_COMMAND_STDOUT_PATTERN = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;
const LOCAL_COMMAND_INVOCATION_PATTERN = /<command-name>([\s\S]*?)<\/command-name>/;

function extractLocalCommandStdout(content: string): string | null {
  const match = content.match(LOCAL_COMMAND_STDOUT_PATTERN);
  return match?.[1]?.trim() ?? null;
}

function isLocalCommandInvocation(content: string): boolean {
  return LOCAL_COMMAND_INVOCATION_PATTERN.test(content);
}

/**
 * Code's real transcript shape (`__fixtures__/0-say-lol-session.jsonl`) is
 * `{input_tokens, output_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens, service_tier}`; only the two counts the wire
 * event actually carries are pulled out. Cache tokens are folded into
 * neither count — `inputTokens` is exactly what the provider billed as
 * "input" for this call, not an inflated total. `undefined` (not zeros) on
 * anything malformed/missing so a line with no usage mints no envelope at
 * all, matching every other optional-field mapping in this file.
 */
function pickUsage(
  message: RawJSONLines,
): { inputTokens: number; outputTokens: number } | undefined {
  const raw = (message as unknown as { message?: { usage?: unknown } }).message?.usage;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const usage = raw as { input_tokens?: unknown; output_tokens?: unknown };
  if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
    return undefined;
  }
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

function pickExplicitProviderSubagent(message: RawJSONLines): string | undefined {
  const raw = message as unknown as { parent_tool_use_id?: unknown; parentToolUseId?: unknown };
  if (typeof raw.parent_tool_use_id === "string" && raw.parent_tool_use_id.length > 0) {
    return raw.parent_tool_use_id;
  }
  if (typeof raw.parentToolUseId === "string" && raw.parentToolUseId.length > 0) {
    return raw.parentToolUseId;
  }
  return undefined;
}

function pickMessageContent(message: RawJSONLines): unknown {
  return (message as unknown as { message?: { content?: unknown } }).message?.content;
}

function pickContentBlocks(message: RawJSONLines): RawContentBlock[] {
  const content = pickMessageContent(message);
  return Array.isArray(content) ? (content as RawContentBlock[]) : [];
}

function normalizePrompt(prompt: string): string {
  return prompt.trim();
}

function pickSidechainRootPrompt(message: RawJSONLines): string | undefined {
  if (message.type !== "user") return undefined;
  const content = pickMessageContent(message);
  if (typeof content !== "string") return undefined;
  const normalized = normalizePrompt(content);
  return normalized.length > 0 ? normalized : undefined;
}

function pickTaskPrompt(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const prompt = (input as { prompt?: unknown }).prompt;
  if (typeof prompt !== "string") return undefined;
  const normalized = normalizePrompt(prompt);
  return normalized.length > 0 ? normalized : undefined;
}

function toToolArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (input === undefined) return {};
  return { input };
}

function toolTitle(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const description = (input as { description?: unknown }).description;
    if (typeof description === "string" && description.trim().length > 0) {
      return description.length > 80 ? `${description.slice(0, 77)}...` : description;
    }
  }
  return `${name} call`;
}

// `acp/acpToEnvelope.ts`'s own `RISK_BY_KIND`, keyed by ACP `kind` there —
// Claude Code's raw transcript instead names the tool directly, so this is
// keyed by tool name). ---

const RISK_BY_TOOL_NAME: Record<string, "read" | "write" | "exec" | "network"> = {
  Bash: "exec",
  Edit: "write",
  Write: "write",
  MultiEdit: "write",
  NotebookEdit: "write",
  Read: "read",
  Grep: "read",
  Glob: "read",
  LS: "read",
  WebFetch: "network",
  WebSearch: "network",
};

function pickRisk(name: string): "read" | "write" | "exec" | "network" | undefined {
  return RISK_BY_TOOL_NAME[name];
}

// server/web-side only, driven by the web composer's upload button — see
// `optimistic-composer.ts:63`), so a transcript image is inlined directly
// into the wire `file` event's `ref` as `inline:<base64>` when it's small
// enough (≤256KB) to be a reasonable envelope payload; a larger image is
// dropped in favor of an honest `service` note rather than silently
// truncating or blowing up an outbox batch.

const MAX_INLINE_IMAGE_BYTES = 256 * 1024;

const IMAGE_EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function imageFileName(mediaType: string): string {
  return `image.${IMAGE_EXTENSION_BY_MEDIA_TYPE[mediaType] ?? "png"}`;
}

/** Conservative byte-size estimate from a base64 string's length (padding ignored — fine for a size hint, not a checksum). */
function approxBase64Bytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

interface RawImageSource {
  mediaType: string;
  data: string;
}

function pickImageSource(block: RawImageBlock): RawImageSource | undefined {
  const source = block.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const raw = source as { type?: unknown; media_type?: unknown; data?: unknown };
  if (raw.type !== "base64") return undefined;
  if (typeof raw.media_type !== "string" || typeof raw.data !== "string") return undefined;
  if (raw.data.length === 0) return undefined;
  return { mediaType: raw.media_type, data: raw.data };
}

/** Maps one image content block to a `file` (inlined, ≤256KB) or `service` (too large) envelope; `undefined` when the block isn't a recognizable image. */
function imageBlockToEnvelope(
  block: RawImageBlock,
  role: SessionRole,
  opts: CreateEnvelopeOptions,
): SessionEnvelope | undefined {
  const source = pickImageSource(block);
  if (!source) return undefined;
  const size = approxBase64Bytes(source.data);
  if (size > MAX_INLINE_IMAGE_BYTES) {
    return createEnvelope(role, { t: "service", text: "image omitted (too large)" }, opts);
  }
  return createEnvelope(
    role,
    { t: "file", ref: `inline:${source.data}`, name: imageFileName(source.mediaType), size },
    opts,
  );
}

// --- Task-prompt -> subagent fallback matching ---
// Some transcripts (see __fixtures__/task-non-sdk.jsonl) never set
// `parent_tool_use_id` on a subagent's messages — the only link back to the
// launching `Task` call is that the sidechain's root `user` message content
// equals the `Task` tool_use's `prompt` input, verbatim.

function queueTaskPromptSubagent(
  state: ClaudeEnvelopeMapperState,
  prompt: string,
  providerSubagent: string,
): void {
  const normalized = normalizePrompt(prompt);
  if (normalized.length === 0) return;
  const map = taskPromptToProviderSubagents(state);
  const queue = map.get(normalized) ?? [];
  if (!queue.includes(providerSubagent)) queue.push(providerSubagent);
  map.set(normalized, queue);
}

function consumeTaskPromptSubagent(
  state: ClaudeEnvelopeMapperState,
  prompt: string,
): string | undefined {
  const normalized = normalizePrompt(prompt);
  if (normalized.length === 0) return undefined;
  const map = taskPromptToProviderSubagents(state);
  const queue = map.get(normalized);
  if (!queue || queue.length === 0) return undefined;
  const providerSubagent = queue.shift();
  if (queue.length === 0) map.delete(normalized);
  return providerSubagent;
}

/** Last-resort fallback: exactly one Task is pending with no better match. */
function consumeSinglePendingTaskSubagent(state: ClaudeEnvelopeMapperState): string | undefined {
  const map = taskPromptToProviderSubagents(state);
  let candidateKey: string | null = null;
  let candidateSubagent: string | null = null;

  for (const [prompt, queue] of map.entries()) {
    if (queue.length === 0) continue;
    if (candidateKey !== null) return undefined; // more than one candidate: ambiguous
    candidateKey = prompt;
    candidateSubagent = queue[0] ?? null;
  }
  if (!candidateKey || !candidateSubagent) return undefined;

  const queue = map.get(candidateKey);
  if (!queue || queue.length === 0) return undefined;
  queue.shift();
  if (queue.length === 0) map.delete(candidateKey);
  return candidateSubagent;
}

// --- subagent scope resolution ---

function resolveProviderSubagent(
  message: RawJSONLines,
  state: ClaudeEnvelopeMapperState,
): string | undefined {
  const explicit = pickExplicitProviderSubagent(message);
  if (explicit) return explicit;

  const parentUuid = pickParentUuid(message);
  if (parentUuid) {
    const inherited = uuidToProviderSubagent(state).get(parentUuid);
    if (inherited) return inherited;
  }

  if (!isSidechainMessage(message)) return undefined;

  const prompt = pickSidechainRootPrompt(message);
  if (prompt) {
    const matched = consumeTaskPromptSubagent(state, prompt);
    if (matched) return matched;
  }

  if (!parentUuid) return consumeSinglePendingTaskSubagent(state);
  return undefined;
}

function rememberSubagentForMessage(
  message: RawJSONLines,
  state: ClaudeEnvelopeMapperState,
  providerSubagent: string | undefined,
): void {
  if (!providerSubagent) return;
  const uuid = pickUuid(message);
  if (!uuid) return;
  uuidToProviderSubagent(state).set(uuid, providerSubagent);
}

function bufferForSubagent(
  state: ClaudeEnvelopeMapperState,
  providerSubagent: string,
  message: RawJSONLines,
): void {
  const buffer = bufferedSubagentMessages(state);
  const queue = buffer.get(providerSubagent) ?? [];
  queue.push(message);
  buffer.set(providerSubagent, queue);
}

function consumeBufferedMessages(
  state: ClaudeEnvelopeMapperState,
  providerSubagent: string,
): RawJSONLines[] {
  const buffer = bufferedSubagentMessages(state);
  const queue = buffer.get(providerSubagent) ?? [];
  buffer.delete(providerSubagent);
  return queue;
}

// --- turn lifecycle ---

function ensureTurn(state: ClaudeEnvelopeMapperState, envelopes: SessionEnvelope[]): string {
  if (state.currentTurnId) return state.currentTurnId;
  const turnId = createId();
  envelopes.push(createEnvelope("agent", { t: "turn-start" }, { turn: turnId }));
  state.currentTurnId = turnId;
  return turnId;
}

function maybeEmitSubagentStart(
  state: ClaudeEnvelopeMapperState,
  turn: string,
  subagent: string | undefined,
  envelopes: SessionEnvelope[],
): void {
  if (!subagent) return;
  const started = startedSubagents(state);
  if (started.has(subagent)) return;
  envelopes.push(createEnvelope("agent", { t: "sub-start" }, { turn, subagent }));
  started.add(subagent);
  activeSubagents(state).add(subagent);
}

function maybeEmitSubagentStop(
  state: ClaudeEnvelopeMapperState,
  turn: string,
  subagent: string,
  envelopes: SessionEnvelope[],
): void {
  const active = activeSubagents(state);
  if (!active.has(subagent)) return;
  envelopes.push(createEnvelope("agent", { t: "sub-stop" }, { turn, subagent }));
  active.delete(subagent);
}

function emitActiveSubagentStops(
  state: ClaudeEnvelopeMapperState,
  turn: string,
  envelopes: SessionEnvelope[],
): void {
  const active = activeSubagents(state);
  for (const subagent of active) {
    envelopes.push(createEnvelope("agent", { t: "sub-stop" }, { turn, subagent }));
  }
  active.clear();
}

function clearSubagentTracking(state: ClaudeEnvelopeMapperState): void {
  uuidToProviderSubagent(state).clear();
  taskPromptToProviderSubagents(state).clear();
  providerCallIds(state).clear();
  providerSubagentIds(state).clear();
  bufferedSubagentMessages(state).clear();
  hiddenParentToolCalls(state).clear();
  startedSubagents(state).clear();
  activeSubagents(state).clear();
}

function closeTurn(
  state: ClaudeEnvelopeMapperState,
  status: SessionTurnEndStatus,
  envelopes: SessionEnvelope[],
): void {
  if (!state.currentTurnId) return;
  emitActiveSubagentStops(state, state.currentTurnId, envelopes);
  envelopes.push(createEnvelope("agent", { t: "turn-end", status }, { turn: state.currentTurnId }));
  state.currentTurnId = null;
  clearSubagentTracking(state);
}

/** Force-closes the current turn (crash/cancel) — no transcript line drives this. */
export function closeClaudeTurnWithStatus(
  state: ClaudeEnvelopeMapperState,
  status: SessionTurnEndStatus,
): SessionEnvelope[] {
  const envelopes: SessionEnvelope[] = [];
  closeTurn(state, status, envelopes);
  return envelopes;
}

/**
 * Maps one parsed Claude Code transcript line to zero or more
 * `SessionEnvelope`s, mutating `state` in place (turn id, id maps, subagent
 * tracking) so the next call sees a consistent session.
 */
export function mapClaudeToEnvelopes(
  message: RawJSONLines,
  state: ClaudeEnvelopeMapperState,
): SessionEnvelope[] {
  const envelopes: SessionEnvelope[] = [];

  const providerSubagent = resolveProviderSubagent(message, state);
  const subagent = providerSubagent ? lookupSubagentId(state, providerSubagent) : undefined;
  rememberSubagentForMessage(message, state, providerSubagent);

  if (providerSubagent && !subagent) {
    bufferForSubagent(state, providerSubagent, message);
    return envelopes;
  }

  if (message.type === "summary" || message.type === "system") return envelopes;

  // conversation history with a synthetic summary Claude Code re-injects as
  // its own assistant record. Surfaced as a quiet `service` marker rather
  // than dropped — no turn is opened for it, matching the pre-existing
  // "untouched `currentTurnId`" contract this line never had a turn to
  // begin with.
  if (message.type === "assistant" && isCompactSummaryMessage(message)) {
    envelopes.push(createEnvelope("agent", { t: "service", text: "History compacted (/clear)" }));
    return envelopes;
  }

  if (message.type === "assistant") {
    const turnId = ensureTurn(state, envelopes);
    maybeEmitSubagentStart(state, turnId, subagent, envelopes);

    for (const block of pickContentBlocks(message)) {
      if (block.type === "text" && typeof (block as RawTextBlock).text === "string") {
        envelopes.push(
          createEnvelope(
            "agent",
            { t: "text", md: (block as RawTextBlock).text as string },
            { turn: turnId, subagent },
          ),
        );
        continue;
      }

      if (block.type === "thinking" && typeof (block as RawThinkingBlock).thinking === "string") {
        envelopes.push(
          createEnvelope(
            "agent",
            { t: "text", md: (block as RawThinkingBlock).thinking as string, thinking: true },
            { turn: turnId, subagent },
          ),
        );
        continue;
      }

      if (block.type === "tool_use") {
        const toolUseBlock = block as RawToolUseBlock;
        const providerCallId =
          typeof toolUseBlock.id === "string" && toolUseBlock.id.length > 0
            ? toolUseBlock.id
            : createId();
        const name =
          typeof toolUseBlock.name === "string" && toolUseBlock.name.length > 0
            ? toolUseBlock.name
            : "unknown";

        // Mint (or fetch) a subagent identity for every tool call, not just
        // `Task` — see file header: this is what stops an orphaned child
        // whose parent call turns out not to be `Task` from buffering
        // forever.
        mintedId(providerSubagentIds(state), providerCallId);

        if (name === "Task") {
          const prompt = pickTaskPrompt(toolUseBlock.input);
          if (prompt) queueTaskPromptSubagent(state, prompt, providerCallId);
          hiddenParentToolCalls(state).add(providerCallId);

          for (const bufferedMessage of consumeBufferedMessages(state, providerCallId)) {
            envelopes.push(...mapClaudeToEnvelopes(bufferedMessage, state));
          }
          continue;
        }

        const call = mintedId(providerCallIds(state), providerCallId);
        const title = toolTitle(name, toolUseBlock.input);
        const risk = pickRisk(name);
        envelopes.push(
          createEnvelope(
            "agent",
            {
              t: "tool-start",
              call,
              name,
              title,
              args: toToolArgs(toolUseBlock.input),
              ...(risk !== undefined ? { risk } : {}),
            },
            { turn: turnId, subagent },
          ),
        );

        // Defensive flush: see the `mintedId` call above — a child could
        // have buffered against this call id even though it isn't a `Task`.
        for (const bufferedMessage of consumeBufferedMessages(state, providerCallId)) {
          envelopes.push(...mapClaudeToEnvelopes(bufferedMessage, state));
        }
      }
    }

    // assistant record that carries one, in the same turn/subagent scope as
    // the content just emitted above; a web client renders it as a per-turn
    // token chip. Emitted last so it always trails the text/tool-start
    // envelopes it's reporting on.
    const usage = pickUsage(message);
    if (usage) {
      envelopes.push(
        createEnvelope(
          "agent",
          { t: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
          { turn: turnId, subagent },
        ),
      );
    }

    return envelopes;
  }

  if (message.type === "user") {
    // SDK-injected synthetic user messages (isMeta) feed a prompt back to
    // Claude without a human ever seeing it — skip, or a 10-20k character
    // wall of text lands in the chat as if the user typed it.
    if (isMetaMessage(message)) return envelopes;

    const content = pickMessageContent(message);

    if (typeof content === "string") {
      const stdout = extractLocalCommandStdout(content);
      if (stdout !== null) {
        // A local slash command's result (e.g. /model) — never a real chat
        // turn; surface it as a quiet service marker with ANSI/wrapping
        // stripped, reusing modelChange.ts's own cleaner (bug-fix-plan.md
        // #4). No turn is opened/closed for it, matching the compact-summary
        // marker's precedent above.
        envelopes.push(
          createEnvelope("agent", { t: "service", text: normalizeTranscriptText(stdout) }),
        );
        return envelopes;
      }
      if (isLocalCommandInvocation(content)) {
        // The invocation record itself (e.g. "/model haiku") carries no
        // useful information beyond what its stdout result already reports —
        // drop it rather than showing the raw XML wrapper as a user chat
        // bubble.
        return envelopes;
      }
      if (isSidechainMessage(message)) {
        const turnId = ensureTurn(state, envelopes);
        maybeEmitSubagentStart(state, turnId, subagent, envelopes);
        envelopes.push(
          createEnvelope("agent", { t: "text", md: content }, { turn: turnId, subagent }),
        );
      } else {
        closeTurn(state, "completed", envelopes);
        envelopes.push(createEnvelope("user", { t: "text", md: content }));
      }
      return envelopes;
    }

    const blocks = pickContentBlocks(message);
    if (blocks.length === 0) return envelopes;

    const hasToolResult = blocks.some((block) => block.type === "tool_result");
    const sidechain = isSidechainMessage(message);

    if (!sidechain && !hasToolResult) {
      closeTurn(state, "completed", envelopes);
      for (const block of blocks) {
        if (block.type === "text" && typeof (block as RawTextBlock).text === "string") {
          const text = (block as RawTextBlock).text as string;
          if (text.trim().length > 0)
            envelopes.push(createEnvelope("user", { t: "text", md: text }));
          continue;
        }
        if (block.type === "image") {
          const imageEnvelope = imageBlockToEnvelope(block as RawImageBlock, "user", {});
          if (imageEnvelope) envelopes.push(imageEnvelope);
        }
      }
      return envelopes;
    }

    const turnId = ensureTurn(state, envelopes);
    if (sidechain) maybeEmitSubagentStart(state, turnId, subagent, envelopes);

    for (const block of blocks) {
      if (block.type === "tool_result") {
        const resultBlock = block as RawToolResultBlock;
        const providerCallId =
          typeof resultBlock.tool_use_id === "string" ? resultBlock.tool_use_id : undefined;
        if (!providerCallId) continue;

        // Not gated on `!sidechain`: a Task launched *from inside* another
        // subagent's own scope (nested Task) reports its own tool_result in
        // a message that is itself isSidechain — hiddenParentToolCalls and
        // maybeEmitSubagentStop must still fire for it, or it leaks a
        // dangling tool-end with no matching tool-start. `maybeEmitSubagentStop`
        // is separately guarded by `activeSubagents`, so running this
        // unconditionally is safe for ordinary (non-Task) nested tool calls
        // too — their defensively-minted subagent id was never started, so
        // the stop is a no-op for them either way.
        const subagentForResult = lookupSubagentId(state, providerCallId);
        if (hiddenParentToolCalls(state).has(providerCallId)) {
          if (subagentForResult) maybeEmitSubagentStop(state, turnId, subagentForResult, envelopes);
          hiddenParentToolCalls(state).delete(providerCallId);
          continue; // Task's call was never shown — no tool-end for it.
        }
        if (subagentForResult) maybeEmitSubagentStop(state, turnId, subagentForResult, envelopes);

        const call = mintedId(providerCallIds(state), providerCallId);
        const ok = resultBlock.is_error !== true;
        envelopes.push(
          createEnvelope(
            "agent",
            {
              t: "tool-end",
              call,
              ok,
              ...(resultBlock.content !== undefined ? { output: resultBlock.content } : {}),
            },
            { turn: turnId, subagent },
          ),
        );

        // A tool result's own `content` can itself be a block array (e.g.
        // `Read` on an image file) — surface any image blocks nested in it
        // as their own `file`/`service` envelopes, right after the tool-end
        // content untouched either way — this only adds envelopes, it
        // doesn't rewrite tool-end's payload.
        if (Array.isArray(resultBlock.content)) {
          for (const nested of resultBlock.content as RawContentBlock[]) {
            if (nested.type !== "image") continue;
            const imageEnvelope = imageBlockToEnvelope(nested as RawImageBlock, "agent", {
              turn: turnId,
              subagent,
            });
            if (imageEnvelope) envelopes.push(imageEnvelope);
          }
        }
        continue;
      }

      if (block.type === "text" && typeof (block as RawTextBlock).text === "string") {
        const text = (block as RawTextBlock).text as string;
        if (text.trim().length > 0) {
          envelopes.push(
            createEnvelope("agent", { t: "text", md: text }, { turn: turnId, subagent }),
          );
        }
        continue;
      }

      if (block.type === "image") {
        const imageEnvelope = imageBlockToEnvelope(block as RawImageBlock, "agent", {
          turn: turnId,
          subagent,
        });
        if (imageEnvelope) envelopes.push(imageEnvelope);
      }
    }

    return envelopes;
  }

  return envelopes;
}
