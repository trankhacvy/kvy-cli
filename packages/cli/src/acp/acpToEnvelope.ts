/**
 * Maps ACP (`@agentclientprotocol/sdk`) `session/update` notifications onto
 * `@falcon/wire`'s `SessionEnvelope` stream — the single, provider-agnostic
 * mapper design §7.3 calls for: "The ACP -> `SessionEnvelope` mapper
 * (`acpToEnvelope`) is likewise single and shared: ACP `session/update`
 * notification kinds map 1:1 onto the existing envelope events
 * (`agent_message_chunk`->`text`, `agent_thought_chunk`->`text{thinking}`,
 * `tool_call`/`tool_call_update`->`tool-start`/`tool-end`,
 * `session/prompt` call/return->`turn-start`/`turn-end`, tool-call
 * `_meta.claudeCode.parentToolUseId`->`subagent` scope). Unknown ACP update
 * kinds are logged and dropped ... the wire schema is closed and stays
 * provider-agnostic." (plan.md §16 "Phase 2.1 - ACP core".)
 *
 * This is a pure mapping module (plan.md: "independently buildable and
 * testable against literal ACP `session/update` JSON fixtures ... without
 * needing `acpConnection.ts` to exist yet") — it has no dependency on
 * `@agentclientprotocol/sdk` at all. Like `../remote/sdkToEnvelope.ts`
 * narrows `@anthropic-ai/claude-agent-sdk`'s `SDKMessage` to a private
 * structural interface instead of importing the SDK's own types, this file
 * defines `AcpSessionUpdate` as a narrow structural type reading only the
 * fields the mapping rules actually need — decoupled from ACP SDK version
 * churn, and buildable before `acpConnection.ts` (a sibling, not-yet-landed
 * task) ever adds the SDK as a real dependency.
 *
 * Session/update kinds handled (design §7.3's mapping table):
 *  - `agent_message_chunk`      -> `text` (coalesced — see below)
 *  - `agent_thought_chunk`      -> `text{thinking:true}` (coalesced)
 *  - `tool_call`                -> `tool-start`
 *  - `tool_call_update`         -> `tool-end`, only once `status` reaches a
 *    terminal value (`completed`/`failed`) — ACP has no wire equivalent for
 *    intermediate `pending`/`in_progress` transitions, matching the existing
 *    Claude/Codex mappers' start/end-only lifecycle.
 *  - `user_message_chunk`       -> intentionally dropped, no log. The prompt
 *    text is already emitted synchronously by whatever calls `session/prompt`
 *    (mirrors `sdkToEnvelope.ts`'s identical rule for SDK-echoed user
 *    messages) — mapping it here too would duplicate it.
 *  - everything else (`plan`/`plan_update`/`plan_removed`,
 *    `current_mode_update`, `available_commands_update`, `session_info_
 *    update`, `usage_update`, `config_option_update`, and any future/unknown
 *    kind) -> logged and dropped. None of these has a `SessionEventSchema`
 *    equivalent; in particular ACP's `current_mode_update` (a permission-mode
 *    change inside one ACP session) must NOT be folded into the wire's
 *    `mode-switch` event, which means something unrelated (Falcon's own
 *    local<->remote control handoff, design §7.5).
 *
 * `session/prompt`'s call/return boundary is not a `session/update`
 * notification — it is synthesized by the caller (`acpConnection.ts` /
 * `claudeRemoteLauncher.ts`, Phase 2.2) around the request itself. This file
 * exports `startAcpTurn`/`endAcpTurn`/`closeAcpTurnWithStatus` for that
 * purpose, mirroring `closeClaudeTurnWithStatus`/`closeCodexTurnWithStatus`.
 *
 * Subagent scope: design §7.3 calls out "tool-call
 * `_meta.claudeCode.parentToolUseId`->`subagent` scope" specifically for tool
 * calls; this mapper applies the same `_meta.claudeCode.parentToolUseId`
 * lookup to every update kind that carries `_meta` (message/thought chunks
 * included), because a subagent's own reasoning/text needs the same scope a
 * subagent's own tool calls do — see
 * `trace_acp_parent_tool_use_subagent.json` (Phase 2.0
 * wire-envelope-verification fixture), whose `e3` thinking-chunk envelope
 * carries `subagent: "acp-task-1"` alongside the nested tool call. Per that
 * same fixture's description, "the subagent id equals the spawning
 * Task-like call's id" — this mapper mints exactly one cuid2 per raw ACP id
 * (tool call id *or* parent-tool-use id) from a single shared map, so the
 * cuid2 minted for a parent's own `tool_call.toolCallId` is byte-for-byte the
 * same cuid2 a child's `_meta.claudeCode.parentToolUseId` resolves to.
 *
 * Two explicit assumptions this mapper makes about fields the public ACP
 * spec does not pin down precisely, called out here (and in the task
 * summary) for the golden-trace-fixture task (Phase 2.1, next bullet) to
 * confirm or correct against a real adapter run:
 *  1. `_meta` is readable on every `session/update` variant (message/thought
 *     chunks included), not only `tool_call`/`tool_call_update` — ACP's
 *     `_meta` extension point is generic across protocol objects.
 *  2. A tool call's provider-native "kind" identifier (Claude's raw tool name
 *     — `Bash`, `Write`, `Task`, ...) is read from `_meta.claudeCode.toolName`
 *     when present (best fidelity for the Claude adapter specifically, same
 *     `_meta.claudeCode` namespace design §7.3 already established for
 *     `parentToolUseId`), falling back to ACP's own standardized `kind`
 *     taxonomy (`read`/`edit`/`execute`/...) for any other ACP-conformant
 *     agent, and finally the literal string `"tool"` if neither is present.
 *
 * `stopReason` -> `turn-end.status` (design: "stopReason -> status"):
 *  - `end_turn`  -> `completed`
 *  - `cancelled` -> `cancelled`
 *  - anything else (`max_tokens`, `max_turn_requests`, `refusal`, or an
 *    unrecognized future value) -> `failed` — the turn stopped without
 *    reaching a natural or user-requested end, which is closer to a failure
 *    than either other status for `SessionEventSchema`'s three-way enum.
 *
 * ## Text-chunk coalescing (v2 review fix — fragmentation)
 *
 * The Claude adapter runs the SDK with `includePartialMessages: true`
 * (verified in `@agentclientprotocol/claude-agent-acp@0.59.0`'s published
 * source), so `agent_message_chunk`/`agent_thought_chunk` arrive as
 * **per-delta fragments** — a few characters each — not whole text blocks.
 * Emitting one wire envelope per chunk would fragment the web timeline into
 * an item per fragment (the reducer renders one `RenderItem` per `text`
 * envelope, `web/src/sync/reducer/reduce.ts` — it never merges) and persist
 * every fragment as a row-sized envelope in Postgres forever. Instead,
 * consecutive chunks accumulate in `state.pendingText` and emit as ONE
 * `text` envelope when the run breaks:
 *  - a chunk with a different (turn, subagent, thinking, messageId) key —
 *    `messageId` is the adapter's own top-level per-assistant-message id
 *    stamp (its `applyMessageId`), so distinct assistant messages become
 *    distinct envelopes exactly like v1's per-SDK-message granularity;
 *  - a `tool_call` / terminal `tool_call_update` emission (envelope order
 *    on the wire must match event order);
 *  - the turn closing (`closeAcpTurnWithStatus`/`endAcpTurn`).
 * Callers that want lower perceived latency for long text blocks can also
 * flush explicitly via `flushAcpText` (e.g. on a timer) — each flush simply
 * ends the current run at a block boundary of its choosing.
 */

import { createEnvelope, type SessionEnvelope, type SessionEvent } from "@falcon/wire";
import { createId } from "@paralleldrive/cuid2";
import type { Logger } from "../logger.js";

export type SessionTurnEndStatus = Extract<SessionEvent, { t: "turn-end" }>["status"];

/**
 * The narrow structural shape this mapper reads off one ACP `session/update`
 * notification's `update` field (i.e. `SessionNotification.update` from
 * `@agentclientprotocol/sdk`). Every field but the `sessionUpdate`
 * discriminant is optional/`unknown` and read defensively — a malformed or
 * unexpected shape from the agent process must never throw here.
 */
export interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: unknown;
  toolCallId?: unknown;
  title?: unknown;
  kind?: unknown;
  status?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  /** Adapter-stamped per-assistant-message id on message/thought chunks (see "Text-chunk coalescing" in the file header). */
  messageId?: unknown;
  _meta?: unknown;
}

/** An open, not-yet-emitted run of coalesced text/thinking chunks (file header: "Text-chunk coalescing"). */
interface PendingTextRun {
  turn: string;
  subagent?: string;
  thinking: boolean;
  messageId?: string;
  parts: string[];
}

/** Mutable, per-session mapper state — construct with `createAcpEnvelopeMapperState()`. */
export interface AcpEnvelopeMapperState {
  currentTurnId: string | null;
  /** One shared provider-id -> cuid2 map for both tool-call ids and parent-tool-use ids (see file header). */
  providerIds?: Map<string, string>;
  /** call cuid -> subagent cuid, remembered from a `tool_call`'s own `_meta` so a later `tool_call_update` (which may omit `_meta`) keeps the same scope. */
  subagentByCall?: Map<string, string>;
  /** Subagent cuids that have already emitted `sub-start` in the current turn. */
  startedSubagents?: Set<string>;
  /** Subagent cuids currently open (no `sub-stop` emitted yet) in the current turn. */
  activeSubagents?: Set<string>;
  /** Open coalesced text run, if any — flushed on run break / tool emission / turn close / `flushAcpText`. */
  pendingText?: PendingTextRun | null;
}

export function createAcpEnvelopeMapperState(): AcpEnvelopeMapperState {
  return { currentTurnId: null };
}

// --- lazy accessors for the optional state maps/sets ---

function providerIds(state: AcpEnvelopeMapperState): Map<string, string> {
  if (!state.providerIds) state.providerIds = new Map();
  return state.providerIds;
}

function subagentByCall(state: AcpEnvelopeMapperState): Map<string, string> {
  if (!state.subagentByCall) state.subagentByCall = new Map();
  return state.subagentByCall;
}

function startedSubagents(state: AcpEnvelopeMapperState): Set<string> {
  if (!state.startedSubagents) state.startedSubagents = new Set();
  return state.startedSubagents;
}

function activeSubagents(state: AcpEnvelopeMapperState): Set<string> {
  if (!state.activeSubagents) state.activeSubagents = new Set();
  return state.activeSubagents;
}

/** Mints a cuid2 for a raw ACP id the first time it's seen; stable after. */
function mintedId(state: AcpEnvelopeMapperState, providerId: string): string {
  const map = providerIds(state);
  const existing = map.get(providerId);
  if (existing) return existing;
  const minted = createId();
  map.set(providerId, minted);
  return minted;
}

function clearMapperState(state: AcpEnvelopeMapperState): void {
  providerIds(state).clear();
  subagentByCall(state).clear();
  startedSubagents(state).clear();
  activeSubagents(state).clear();
  state.pendingText = null;
}

/**
 * Emits the open text run (if any) as one `text` envelope, preceded by its
 * subagent's `sub-start` when that scope hasn't opened yet. A run whose
 * accumulated text is empty emits nothing. Always clears the run.
 */
function flushPendingText(state: AcpEnvelopeMapperState, envelopes: SessionEnvelope[]): void {
  const run = state.pendingText;
  state.pendingText = null;
  if (!run) return;
  const md = run.parts.join("");
  if (md.length === 0) return;
  maybeEmitSubagentStart(state, run.turn, run.subagent, envelopes);
  envelopes.push(
    createEnvelope(
      "agent",
      { t: "text", md, ...(run.thinking ? { thinking: true } : {}) },
      { turn: run.turn, subagent: run.subagent },
    ),
  );
}

/**
 * Public flush for the open text run — lets the transport layer (Phase 2.2's
 * `AcpRemote`) end a long-running text block early (e.g. on a timer) instead
 * of waiting for the next natural run break. Safe to call any time.
 */
export function flushAcpText(state: AcpEnvelopeMapperState): SessionEnvelope[] {
  const envelopes: SessionEnvelope[] = [];
  flushPendingText(state, envelopes);
  return envelopes;
}

// --- narrow, defensive accessors onto AcpSessionUpdate ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function pickToolCallId(update: AcpSessionUpdate): string | undefined {
  return pickString(update.toolCallId);
}

/** `_meta.claudeCode.parentToolUseId` — design §7.3's subagent-scope trigger. */
function pickParentToolUseId(update: AcpSessionUpdate): string | undefined {
  const meta = update._meta;
  if (!isRecord(meta)) return undefined;
  const claudeCode = meta.claudeCode;
  if (!isRecord(claudeCode)) return undefined;
  return pickString(claudeCode.parentToolUseId);
}

/** `_meta.claudeCode.toolName` — see file header assumption 2. */
function pickClaudeCodeToolName(update: AcpSessionUpdate): string | undefined {
  const meta = update._meta;
  if (!isRecord(meta)) return undefined;
  const claudeCode = meta.claudeCode;
  if (!isRecord(claudeCode)) return undefined;
  return pickString(claudeCode.toolName);
}

/** A `session/update` content field is a single ACP `ContentBlock`; only the `text` variant has a wire equivalent. */
function pickContentText(content: unknown): string | undefined {
  if (!isRecord(content)) return undefined;
  if (content.type !== "text") return undefined;
  return typeof content.text === "string" ? content.text : undefined;
}

function pickToolName(update: AcpSessionUpdate): string {
  const claudeName = pickClaudeCodeToolName(update);
  if (claudeName) return claudeName;
  const kind = pickString(update.kind);
  if (kind) return kind;
  return "tool";
}

function pickToolArgs(update: AcpSessionUpdate): unknown {
  return isRecord(update.rawInput) ? update.rawInput : {};
}

const RISK_BY_KIND: Record<string, "read" | "write" | "exec" | "network"> = {
  read: "read",
  search: "read",
  edit: "write",
  delete: "write",
  move: "write",
  execute: "exec",
  fetch: "network",
};

function pickRisk(update: AcpSessionUpdate): "read" | "write" | "exec" | "network" | undefined {
  const kind = pickString(update.kind);
  return kind ? RISK_BY_KIND[kind] : undefined;
}

/** Best-effort text summary of a tool call's `content` array for `tool-end.output`, when no `rawOutput` was given. */
function pickContentSummary(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const text = isRecord(block.content) ? pickContentText(block.content) : undefined;
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function pickToolOutput(update: AcpSessionUpdate): unknown {
  if (update.rawOutput !== undefined) return update.rawOutput;
  return pickContentSummary(update.content);
}

function isTerminalStatus(status: string | undefined): status is "completed" | "failed" {
  return status === "completed" || status === "failed";
}

// --- subagent scope resolution ---

/**
 * Resolves the `subagent` field this envelope should carry, and — for
 * `tool_call`/`tool_call_update` — remembers the association by the call's
 * own minted id so a later update lacking `_meta` still resolves correctly.
 */
function resolveEnvelopeSubagent(
  update: AcpSessionUpdate,
  state: AcpEnvelopeMapperState,
): string | undefined {
  const parentProviderId = pickParentToolUseId(update);
  if (parentProviderId !== undefined) {
    const subagent = mintedId(state, parentProviderId);
    const toolCallId = pickToolCallId(update);
    if (toolCallId !== undefined) {
      subagentByCall(state).set(mintedId(state, toolCallId), subagent);
    }
    return subagent;
  }
  const toolCallId = pickToolCallId(update);
  if (toolCallId !== undefined) {
    return subagentByCall(state).get(mintedId(state, toolCallId));
  }
  return undefined;
}

function maybeEmitSubagentStart(
  state: AcpEnvelopeMapperState,
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
  state: AcpEnvelopeMapperState,
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
  state: AcpEnvelopeMapperState,
  turn: string,
  envelopes: SessionEnvelope[],
): void {
  const active = activeSubagents(state);
  for (const subagent of active) {
    envelopes.push(createEnvelope("agent", { t: "sub-stop" }, { turn, subagent }));
  }
  active.clear();
}

// --- turn lifecycle (synthesized around session/prompt, not a session/update kind) ---

/** Opens a new turn — call immediately before issuing the `session/prompt` request. */
export function startAcpTurn(state: AcpEnvelopeMapperState): SessionEnvelope {
  const turnId = createId();
  state.currentTurnId = turnId;
  return createEnvelope("agent", { t: "turn-start" }, { turn: turnId });
}

/** Force-closes the current turn (crash/interrupt) — no `session/update` drives this. */
export function closeAcpTurnWithStatus(
  state: AcpEnvelopeMapperState,
  status: SessionTurnEndStatus,
): SessionEnvelope[] {
  if (!state.currentTurnId) return [];
  const turn = state.currentTurnId;
  const envelopes: SessionEnvelope[] = [];
  flushPendingText(state, envelopes);
  emitActiveSubagentStops(state, turn, envelopes);
  envelopes.push(createEnvelope("agent", { t: "turn-end", status }, { turn }));
  state.currentTurnId = null;
  clearMapperState(state);
  return envelopes;
}

/** ACP `PromptResponse.stopReason` -> `turn-end.status` (see file header). */
export function mapAcpStopReasonToTurnStatus(stopReason: string): SessionTurnEndStatus {
  if (stopReason === "end_turn") return "completed";
  if (stopReason === "cancelled") return "cancelled";
  return "failed";
}

/** Closes the turn opened by `startAcpTurn`, from the `session/prompt` response's `stopReason`. */
export function endAcpTurn(state: AcpEnvelopeMapperState, stopReason: string): SessionEnvelope[] {
  return closeAcpTurnWithStatus(state, mapAcpStopReasonToTurnStatus(stopReason));
}

// --- session/update mapping ---

function handleTextChunk(
  update: AcpSessionUpdate,
  state: AcpEnvelopeMapperState,
  thinking: boolean,
  logger: Logger | undefined,
): SessionEnvelope[] {
  const turn = state.currentTurnId;
  if (!turn) {
    logger?.warn("acp_session_update_dropped_no_active_turn", {
      sessionUpdate: update.sessionUpdate,
    });
    return [];
  }
  const text = pickContentText(update.content);
  if (text === undefined) {
    logger?.warn("acp_session_update_dropped_unsupported_content", {
      sessionUpdate: update.sessionUpdate,
    });
    return [];
  }

  // Coalescing (file header): append to the open run when the key matches;
  // otherwise flush it and start a new run. Nothing is emitted until a run
  // breaks — chunk-per-delta input must not become envelope-per-delta output.
  const subagent = resolveEnvelopeSubagent(update, state);
  const messageId = pickString(update.messageId);
  const run = state.pendingText;
  if (
    run &&
    run.turn === turn &&
    run.subagent === subagent &&
    run.thinking === thinking &&
    run.messageId === messageId
  ) {
    run.parts.push(text);
    return [];
  }
  const envelopes: SessionEnvelope[] = [];
  flushPendingText(state, envelopes);
  state.pendingText = { turn, subagent, thinking, messageId, parts: [text] };
  return envelopes;
}

function handleToolCall(
  update: AcpSessionUpdate,
  state: AcpEnvelopeMapperState,
  logger: Logger | undefined,
): SessionEnvelope[] {
  const turn = state.currentTurnId;
  if (!turn) {
    logger?.warn("acp_session_update_dropped_no_active_turn", {
      sessionUpdate: update.sessionUpdate,
    });
    return [];
  }
  const toolCallId = pickToolCallId(update);
  if (!toolCallId) {
    logger?.warn("acp_tool_call_dropped_missing_id", {});
    return [];
  }
  const envelopes: SessionEnvelope[] = [];
  flushPendingText(state, envelopes); // wire order must match event order
  const subagent = resolveEnvelopeSubagent(update, state);
  maybeEmitSubagentStart(state, turn, subagent, envelopes);

  const call = mintedId(state, toolCallId);
  const title = pickString(update.title);
  const risk = pickRisk(update);
  envelopes.push(
    createEnvelope(
      "agent",
      {
        t: "tool-start",
        call,
        name: pickToolName(update),
        ...(title !== undefined ? { title } : {}),
        args: pickToolArgs(update),
        ...(risk !== undefined ? { risk } : {}),
      },
      { turn, subagent },
    ),
  );
  return envelopes;
}

function handleToolCallUpdate(
  update: AcpSessionUpdate,
  state: AcpEnvelopeMapperState,
  logger: Logger | undefined,
): SessionEnvelope[] {
  const status = pickString(update.status);
  if (!isTerminalStatus(status)) {
    // Intermediate `pending`/`in_progress` transitions have no wire
    // equivalent — only the terminal completed/failed status closes a
    // tool-start, matching the Claude/Codex mappers' start/end-only lifecycle.
    return [];
  }
  const turn = state.currentTurnId;
  if (!turn) {
    logger?.warn("acp_session_update_dropped_no_active_turn", {
      sessionUpdate: update.sessionUpdate,
    });
    return [];
  }
  const toolCallId = pickToolCallId(update);
  if (!toolCallId) {
    logger?.warn("acp_tool_call_update_dropped_missing_id", {});
    return [];
  }

  const envelopes: SessionEnvelope[] = [];
  flushPendingText(state, envelopes); // wire order must match event order
  const call = mintedId(state, toolCallId);

  // If this call itself is a spawning (subagent) call, its own terminal
  // update closes that subagent's scope first — the tool-end below stays
  // turn-scoped, matching the parent Task call's own tool-start.
  if (activeSubagents(state).has(call)) {
    maybeEmitSubagentStop(state, turn, call, envelopes);
  }

  const subagent = resolveEnvelopeSubagent(update, state);
  const output = pickToolOutput(update);
  envelopes.push(
    createEnvelope(
      "agent",
      {
        t: "tool-end",
        call,
        ok: status === "completed",
        ...(output !== undefined ? { output } : {}),
      },
      { turn, subagent },
    ),
  );
  return envelopes;
}

/**
 * Maps one ACP `session/update` notification's `update` payload to zero or
 * more `SessionEnvelope`s, mutating `state` in place (turn id, id maps,
 * subagent tracking) so the next call sees a consistent session. Never
 * throws — a malformed or unrecognized update is logged and dropped.
 */
export function mapAcpUpdateToEnvelopes(
  update: AcpSessionUpdate,
  state: AcpEnvelopeMapperState,
  logger?: Logger,
): SessionEnvelope[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return handleTextChunk(update, state, false, logger);
    case "agent_thought_chunk":
      return handleTextChunk(update, state, true, logger);
    case "tool_call":
      return handleToolCall(update, state, logger);
    case "tool_call_update":
      return handleToolCallUpdate(update, state, logger);
    case "user_message_chunk":
      // Intentionally not mapped — see file header. Not logged: this is an
      // expected, known kind, not an unrecognized one.
      return [];
    default:
      logger?.warn("acp_session_update_unknown_kind_dropped", {
        sessionUpdate: update.sessionUpdate,
      });
      return [];
  }
}
