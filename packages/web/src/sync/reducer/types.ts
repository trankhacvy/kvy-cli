import type { PermDecision, PermissionMode, SessionRole } from "@kvy/wire";

/**
 * for a (later, out of scope here) timeline UI to map 1:1 onto components.
 *
 * wire protocol is a flatter discriminated-union event stream
 * (`SessionEvent`), so the shapes below are a fresh design that preserves the
 * tool-use matching by name+args, subagent/sidechain linking, dedupe by
 * envelope id, and turn/tool pairing into a stable ordered list.
 */

export interface RenderItemBase {
  /** The envelope id that anchors this item (its first contributing envelope). */
  id: string;
  time: number;
  role: SessionRole;
  turn?: string;
}

export interface TextItem extends RenderItemBase {
  kind: "text";
  md: string;
  thinking: boolean;
}

export interface ServiceItem extends RenderItemBase {
  kind: "service";
  text: string;
  /** True for routine boundary chatter ("session started" and the like) that
   * carries no information a user needs to see — these stay hidden from the
   * main transcript (`transcript-view.ts`'s `isHiddenTimelineItem`). False
   * for everything else (model-switch confirmations, compaction notices,
   * omitted-attachment notes, remote-session errors, ...), which previously
   * were *all* unconditionally hidden alongside the routine ones — a
   * web-side gap that has since been fixed. */
  quiet: boolean;
}

export interface FileItem extends RenderItemBase {
  kind: "file";
  ref: string;
  name: string;
  size: number;
  image?: { w: number; h: number; thumbhash: string };
}

export interface TurnStartItem extends RenderItemBase {
  kind: "turn-start";
}

export interface TurnEndItem extends RenderItemBase {
  kind: "turn-end";
  status: "completed" | "failed" | "cancelled";
}

export interface ModeSwitchItem extends RenderItemBase {
  kind: "mode-switch";
  control: "local" | "remote";
  by: "terminal" | "client";
}

export interface PermissionModeItem extends RenderItemBase {
  kind: "permission-mode";
  mode: PermissionMode;
  source: "terminal" | "client";
}

export interface SubStartItem extends RenderItemBase {
  kind: "sub-start";
}

export interface SubStopItem extends RenderItemBase {
  kind: "sub-stop";
}

export interface UsageItem extends RenderItemBase {
  kind: "usage";
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

/** The agent's task/todo list (ACP's `plan` session/update — codex-acp's own
 * plan/todo tool). Each `plan` wire event carries the full current list, so
 * this item is a snapshot replaced wholesale by the next one, same as
 * `UsageItem`. */
export interface PlanItem extends RenderItemBase {
  kind: "plan";
  steps: Array<{ text: string; status: "pending" | "in_progress" | "completed" }>;
}

/** Live state of a permission request, shared by reference between whatever
 * item currently represents it (a placeholder or the tool it matched) so a
 * later `perm-resolve` updates the right place regardless of match order. */
export interface PermissionInfo {
  reqId: string;
  modes: PermissionMode[];
  decision?: PermDecision;
  /** False when this request was raised by a locally-typed terminal turn —
   * the human at the keyboard, not a web click, drives the outcome, so the
   * card renders read-only. Undefined (an older CLI build) is treated as
   * answerable, matching the pre-existing behavior. */
  answerable?: boolean;
}

/**
 * A `perm-request` that has not (yet, or ever) matched a `tool-start` — no
 * `call` was given and no tool-start with the same name+args has arrived.
 * Rendered standalone rather than dropped (design principle: no silent data
 * loss). If a matching tool-start arrives later, the reducer replaces this
 * item in place with a `ToolItem` carrying the same `permission`.
 */
export interface PermPlaceholderItem extends RenderItemBase {
  kind: "perm-placeholder";
  name: string;
  args: unknown;
  permission: PermissionInfo;
}

export interface ToolItem extends RenderItemBase {
  kind: "tool";
  call: string;
  name: string;
  title?: string;
  args: unknown;
  risk?: "read" | "write" | "exec" | "network";
  status: "running" | "done";
  ok?: boolean;
  output?: unknown;
  permission?: PermissionInfo;
  /** Linked sidechain/subagent scope. */
  subagent?: RenderItem[];
}

/** A `tool-end` whose `call` never had a `tool-start` in this scope
 * (truncated history / adoption boundary) — surfaced, not dropped. */
export interface OrphanToolEndItem extends RenderItemBase {
  kind: "orphan-tool-end";
  call: string;
  ok: boolean;
  output?: unknown;
}

/**
 * A subagent scope that never linked to a parent tool call (no `ToolItem` in
 * the tree has `call === subagentId`) — rendered as its own top-level group
 * at the time of its first envelope, so its content still surfaces.
 */
export interface SubagentGroupItem extends RenderItemBase {
  kind: "subagent-group";
  subagentId: string;
  items: RenderItem[];
}

export type RenderItem =
  | TextItem
  | ServiceItem
  | FileItem
  | TurnStartItem
  | TurnEndItem
  | ModeSwitchItem
  | PermissionModeItem
  | SubStartItem
  | SubStopItem
  | UsageItem
  | PlanItem
  | PermPlaceholderItem
  | ToolItem
  | OrphanToolEndItem
  | SubagentGroupItem;
