/**
 * The `SDKToEnvelope` converter (plan.md §16 "2.1 Remote mode": "`SDKToEnvelope`
 * converter"; design §7.4: "SDK stream → `SDKToEnvelope` converter → ordered
 * outgoing queue").
 *
 * Ported (adapted) from Happy's `SDKToLogConverter`
 * (happy-cli/src/claude/utils/sdkToLogConverter.ts, MIT) — but reshaped for
 * Falcon's architecture rather than translated line-for-line: instead of
 * re-implementing turn/subagent/tool-id tracking a second time for the
 * remote path, this reshapes each live `SDKMessage` from
 * `@anthropic-ai/claude-agent-sdk` into the same `RawJSONLines` shape the
 * local-mode transcript tailer already produces (`claude/types.ts`), then
 * hands it to the already-ported, already-tested `mapClaudeToEnvelopes`
 * (`claude/envelopeMapper.ts`). Local and remote mode therefore share one
 * mapping implementation and can never drift out of sync with each other —
 * a stronger property than Happy has, where the local (`sessionProtocolMapper`)
 * and remote (`SDKToLogConverter` + downstream reducer) paths are two
 * separate implementations.
 *
 * Deltas from Happy's `SDKToLogConverter`:
 *  - No git-branch/version/cwd/display metadata — `RawJSONLinesSchema`
 *    (types.ts) only validates the handful of fields `mapClaudeToEnvelopes`
 *    actually reads (dedup-key uuids) and `.passthrough()`s the rest, so
 *    those Happy-only display fields are simply omitted rather than faked.
 *  - No `permissions` field annotation on `tool_result` blocks — Falcon's
 *    permission pipeline (plan.md §16 "2.3", not landed yet) emits its own
 *    `perm-request`/`perm-resolve` envelopes directly (design §7.6) instead
 *    of annotating the tool result the way Happy's client-rendered log
 *    format did.
 *  - `result` messages are NOT dropped the way Happy drops them (its log
 *    format has no equivalent event): a `result` message is Falcon's actual
 *    `turn-end` signal for the remote path (design §4.2's `turn-end`
 *    envelope) — remote mode has no on-disk transcript file whose next real
 *    user message would otherwise close the turn implicitly, the way local
 *    mode's tailer does.
 *  - Plain-string-content `user` messages (i.e. a human-typed prompt) are
 *    NOT converted here — `claudeRemote.ts`'s `send()` already emits that
 *    exact envelope synchronously at call time (it already has the prompt
 *    text in hand from the RPC that triggered it), so re-deriving it from
 *    whatever the SDK echoes back would risk a duplicate. Only SDK/subprocess
 *    -originated `user` messages that carry a `tool_result` block are
 *    converted here.
 *  - `stream_event` (partial/streaming assistant deltas,
 *    `SDKPartialAssistantMessage`) is intentionally not handled — Falcon
 *    never calls `query()` with `includePartialMessages: true` (there's no
 *    partial-text envelope variant in `SessionEventSchema` to carry it), so
 *    only fully-assembled `assistant` messages are ever converted.
 */
import { randomUUID } from "node:crypto";
import type { SessionEnvelope } from "@falcon/wire";
import {
  type ClaudeEnvelopeMapperState,
  closeClaudeTurnWithStatus,
  createClaudeEnvelopeMapperState,
  mapClaudeToEnvelopes,
  type SessionTurnEndStatus,
} from "../claude/envelopeMapper.js";
import type { RawJSONLines } from "../claude/types.js";

/**
 * The narrow structural shape this converter reads off a live SDK message.
 * `@anthropic-ai/claude-agent-sdk`'s own `SDKMessage` union is large (30+
 * variants covering task/hook/plugin/rate-limit events this converter has
 * no envelope equivalent for) — narrowing to `unknown` and reading only
 * these fields, mirroring `envelopeMapper.ts`'s own narrow-accessor style
 * for the untyped parts of `RawJSONLines`, keeps this file decoupled from
 * SDK version churn in fields it never reads.
 */
interface RawSdkMessage {
  type: string;
  uuid?: unknown;
  parent_tool_use_id?: unknown;
  message?: unknown;
  isSynthetic?: unknown;
  is_error?: unknown;
}

function sdkUuid(message: RawSdkMessage): string {
  return typeof message.uuid === "string" && message.uuid.length > 0 ? message.uuid : randomUUID();
}

function sdkParentToolUseId(message: RawSdkMessage): string | undefined {
  return typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : undefined;
}

function messageHasToolResult(message: RawSdkMessage): boolean {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => (block as { type?: unknown } | undefined)?.type === "tool_result");
}

/**
 * One `RawJSONLines`-shaped line per convertible SDK message, or `null` for
 * message types with no transcript-line equivalent (handled separately, or
 * not handled at all — see the file header's delta list).
 */
function toRawLine(message: RawSdkMessage): RawJSONLines | null {
  const parentToolUseId = sdkParentToolUseId(message);

  if (message.type === "assistant") {
    return {
      type: "assistant",
      uuid: sdkUuid(message),
      message: message.message,
      ...(parentToolUseId !== undefined
        ? { isSidechain: true, parent_tool_use_id: parentToolUseId }
        : {}),
    } as RawJSONLines;
  }

  if (message.type === "user") {
    // Human-typed prompts are emitted directly by claudeRemote.ts's send()
    // — only forward subprocess-originated tool results here.
    if (!messageHasToolResult(message)) return null;
    return {
      type: "user",
      uuid: sdkUuid(message),
      ...(message.isSynthetic === true ? { isMeta: true } : {}),
      message: message.message,
      ...(parentToolUseId !== undefined
        ? { isSidechain: true, parent_tool_use_id: parentToolUseId }
        : {}),
    } as RawJSONLines;
  }

  return null;
}

export class SdkToEnvelopeConverter {
  private readonly state: ClaudeEnvelopeMapperState = createClaudeEnvelopeMapperState();

  /** Converts one live SDK message into zero or more `SessionEnvelope`s. */
  convert(message: unknown): SessionEnvelope[] {
    const raw = message as RawSdkMessage;

    // A `result` message is the remote path's own turn-end signal (see file
    // header) — it has no RawJSONLines shape of its own.
    if (raw.type === "result") {
      return closeClaudeTurnWithStatus(this.state, raw.is_error === true ? "failed" : "completed");
    }

    const line = toRawLine(raw);
    if (!line) return [];
    return mapClaudeToEnvelopes(line, this.state);
  }

  /** Force-closes an in-progress turn (interrupt/session teardown). */
  closeTurn(status: SessionTurnEndStatus): SessionEnvelope[] {
    return closeClaudeTurnWithStatus(this.state, status);
  }
}
