/**
 * Maps Codex `codex/event` notification payloads (`EventMsg`, from
 * `codexAppServerTypes.ts`) onto `@falcon/wire`'s `SessionEnvelope` stream —
 * plan.md §16 "3.4 Codex adapter": "`codexEnvelopeMapper` + reasoning/diff
 * processors"; design §7.7: "events mapped by `codexEnvelopeMapper`."
 *
 * Ported (adapted) from happy-cli/src/codex/utils/sessionProtocolMapper.ts +
 * reasoningProcessor.ts/diffProcessor.ts (MIT —
 * https://github.com/slopus/happy), fidelity (P). The mapping rules for the
 * event types plan.md names (reasoning, diff) plus the surrounding turn/
 * tool lifecycle Codex actually emits:
 *
 *  - `task_started`               -> `turn-start`
 *  - `task_complete`/`turn_aborted` -> `turn-end` (status derived from an
 *    error/reason field, same "failed vs cancelled" rule Happy used)
 *  - `agent_message`              -> `text`
 *  - `agent_reasoning`            -> `text{thinking:true}`
 *  - `exec_command_begin/end`     -> `tool-start`/`tool-end` (`risk: 'exec'`)
 *  - `patch_apply_begin/end`      -> `tool-start`/`tool-end` (`risk: 'write'`)
 *  - `turn_diff`                  -> a synthetic `tool-start`+`tool-end` pair
 *    (name `codex-diff`) whenever the cumulative unified diff changes from
 *    its previous value — Happy's `DiffProcessor` does exactly this (emits a
 *    paired `CodexDiff` tool-call/result), because there's no other event
 *    type carrying a turn's live diff. Falcon has no dedicated "diff" wire
 *    event, so folding it into the existing tool-start/tool-end pair is the
 *    least-invented option.
 *  - anything else (`token_count`, `session_configured`, mcp lifecycle, ...)
 *    -> dropped
 *
 * Deltas from Happy, driven by `@falcon/wire`'s actual (already-merged)
 * contract:
 *
 *  - **No provider ids on the wire.** Same rule `../claude/envelopeMapper.ts`
 *    follows (`session.ts`: "provider-native ids ... never cross the wire").
 *    Every `call_id`/`callId` Codex reports is translated through a
 *    `Map<string, string>` that mints a cuid2 the first time it's seen. This
 *    is a deliberate delta from Happy's own current code, which passes
 *    Codex's raw `call_id` straight through as the wire `call` field.
 *  - **`agent_reasoning_delta`/`agent_reasoning_section_break` are dropped
 *    entirely**, not buffered into a running accumulator. Codex always
 *    follows a run of deltas with one final `agent_reasoning` carrying the
 *    complete text (this is exactly why Happy's own event handler skips
 *    deltas in its UI — see `runCodex.ts`: "Skip reasoning deltas ... to
 *    reduce noise") — so reconstructing text from deltas would only
 *    duplicate what `agent_reasoning` already provides, whole.
 *  - **No subagent/collab-agent scope.** Codex's newer collab-sub-thread
 *    feature (`collab_agent_begin/end`, `subAgentActivity`) has no
 *    equivalent in plan.md's ask for this task — Claude's `Task` tool is the
 *    only cross-provider subagent concept the design doc calls out (design
 *    §7.4's Task-triggers-subagent-scope rule), and it has no Codex parallel
 *    yet.
 *  - **`perm-request`/`perm-resolve` are NOT emitted here.** Exec/patch
 *    approval events (`exec_command_begin` etc. always follow, never
 *    precede, an approval decision) are intentionally not re-mapped into a
 *    duplicate permission card — `permissionHandler.ts` already emits those
 *    directly, same separation Claude's own mapper/handler pair uses.
 */

import { createEnvelope, type SessionEnvelope, type SessionEvent } from "@falcon/wire";
import { createId } from "@paralleldrive/cuid2";
import type { EventMsg } from "./codexAppServerTypes.js";

export type CodexTurnEndStatus = Extract<SessionEvent, { t: "turn-end" }>["status"];

/** Mutable, per-session mapper state — construct with `createCodexEnvelopeMapperState()`. */
export interface CodexEnvelopeMapperState {
  currentTurnId: string | null;
  providerCallIds?: Map<string, string>;
  /** Last unified diff seen from `turn_diff`, for change-detection (Happy's `DiffProcessor.previousDiff`). */
  lastDiff?: string | null;
}

export function createCodexEnvelopeMapperState(): CodexEnvelopeMapperState {
  return { currentTurnId: null, lastDiff: null };
}

function providerCallIds(state: CodexEnvelopeMapperState): Map<string, string> {
  if (!state.providerCallIds) state.providerCallIds = new Map();
  return state.providerCallIds;
}

/** Mints a cuid2 for a provider call id the first time it's seen; stable after. */
function mintedCallId(state: CodexEnvelopeMapperState, providerCallId: string): string {
  const map = providerCallIds(state);
  const existing = map.get(providerCallId);
  if (existing) return existing;
  const minted = createId();
  map.set(providerCallId, minted);
  return minted;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickCallId(msg: EventMsg): string {
  return pickString(msg.call_id) ?? pickString(msg.callId) ?? createId();
}

function pickCommand(msg: EventMsg): string[] {
  const command = msg.command;
  if (Array.isArray(command))
    return command.filter((part): part is string => typeof part === "string");
  return typeof command === "string" ? [command] : [];
}

function commandTitle(command: string[]): string {
  const joined = command.join(" ");
  return joined.length > 0
    ? joined.length > 80
      ? `${joined.slice(0, 77)}...`
      : joined
    : "Execute command";
}

function pickTurnEndStatus(msg: EventMsg, type: string): CodexTurnEndStatus {
  if (type === "turn_aborted") {
    const reason = msg.reason;
    const error = msg.error;
    if (
      (typeof reason === "string" && /(fail|error)/i.test(reason)) ||
      (typeof error === "string" && error.length > 0) ||
      (error !== undefined && error !== null && typeof error === "object")
    ) {
      return "failed";
    }
    return "cancelled";
  }
  return msg.error !== undefined && msg.error !== null ? "failed" : "completed";
}

/** Force-closes the current turn (crash/interrupt) — no `codex/event` line drives this. */
export function closeCodexTurnWithStatus(
  state: CodexEnvelopeMapperState,
  status: CodexTurnEndStatus,
): SessionEnvelope[] {
  if (!state.currentTurnId) return [];
  const envelope = createEnvelope(
    "agent",
    { t: "turn-end", status },
    { turn: state.currentTurnId },
  );
  state.currentTurnId = null;
  return [envelope];
}

/**
 * Maps one Codex `codex/event` message (the `msg` field of the notification)
 * to zero or more `SessionEnvelope`s, mutating `state` in place (turn id,
 * call-id map, last-seen diff) so the next call sees a consistent session.
 */
export function mapCodexEventToEnvelopes(
  msg: EventMsg,
  state: CodexEnvelopeMapperState,
): SessionEnvelope[] {
  const { type } = msg;

  if (type === "task_started") {
    const turnId = createId();
    state.currentTurnId = turnId;
    providerCallIds(state).clear();
    return [createEnvelope("agent", { t: "turn-start" }, { turn: turnId })];
  }

  if (type === "task_complete" || type === "turn_aborted") {
    if (!state.currentTurnId) return [];
    return closeCodexTurnWithStatus(state, pickTurnEndStatus(msg, type));
  }

  // Every event below belongs inside a turn. Codex always emits
  // `task_started` first, but degrade to dropping the event (rather than
  // throwing, or minting a turn implicitly) if one somehow arrives without
  // it — same "no turn => dropped by renderers" rule `session.ts` documents
  // for agent events in general.
  const turn = state.currentTurnId;
  if (!turn) return [];

  if (type === "agent_message") {
    const text = pickString(msg.message);
    return text ? [createEnvelope("agent", { t: "text", md: text }, { turn })] : [];
  }

  if (type === "agent_reasoning") {
    const text = pickString(msg.text);
    return text ? [createEnvelope("agent", { t: "text", md: text, thinking: true }, { turn })] : [];
  }

  if (type === "exec_command_begin") {
    const call = mintedCallId(state, pickCallId(msg));
    const command = pickCommand(msg);
    return [
      createEnvelope(
        "agent",
        {
          t: "tool-start",
          call,
          name: "exec",
          title: commandTitle(command),
          args: { command, cwd: msg.cwd },
          risk: "exec",
        },
        { turn },
      ),
    ];
  }

  if (type === "exec_command_end") {
    const call = mintedCallId(state, pickCallId(msg));
    const exitCode = pickNumber(msg.exit_code) ?? pickNumber(msg.exitCode);
    const stdout =
      pickString(msg.stdout) ?? pickString(msg.aggregated_output) ?? pickString(msg.output);
    const stderr = pickString(msg.stderr);
    return [
      createEnvelope(
        "agent",
        {
          t: "tool-end",
          call,
          ok: exitCode === undefined ? true : exitCode === 0,
          output: { stdout, stderr, exitCode },
        },
        { turn },
      ),
    ];
  }

  if (type === "patch_apply_begin") {
    const call = mintedCallId(state, pickCallId(msg));
    return [
      createEnvelope(
        "agent",
        {
          t: "tool-start",
          call,
          name: "apply_patch",
          title: "Apply patch",
          args: { changes: msg.changes ?? {} },
          risk: "write",
        },
        { turn },
      ),
    ];
  }

  if (type === "patch_apply_end") {
    const call = mintedCallId(state, pickCallId(msg));
    return [
      createEnvelope(
        "agent",
        {
          t: "tool-end",
          call,
          ok: msg.success !== false,
          output: { stdout: pickString(msg.stdout), stderr: pickString(msg.stderr) },
        },
        { turn },
      ),
    ];
  }

  if (type === "turn_diff") {
    const unifiedDiff = pickString(msg.unified_diff);
    if (unifiedDiff === undefined || unifiedDiff === state.lastDiff) return [];
    state.lastDiff = unifiedDiff;
    const call = createId();
    return [
      createEnvelope(
        "agent",
        { t: "tool-start", call, name: "codex-diff", title: "Turn diff", args: { unifiedDiff } },
        { turn },
      ),
      createEnvelope("agent", { t: "tool-end", call, ok: true }, { turn }),
    ];
  }

  if (type === "error") {
    const text = pickString(msg.message) ?? "Codex error";
    return [createEnvelope("agent", { t: "service", text }, { turn })];
  }

  return [];
}
