import type { PermDecision, PermissionMode, SessionRole } from "@falcon/wire";

/**
 * Render items — the output of the reducer (falcon-system-design.md §9.1,
 * plan.md §8.2). `SessionEnvelope[]` in, an ordered `RenderItem[]` out, ready
 * for a (later, out of scope here) timeline UI to map 1:1 onto components.
 *
 * Ported from Happy's `happy-app/sources/sync/reducer/reducer.ts` — logic
 * only. Happy's client renders a nested-content-block message model; Falcon's
 * wire protocol is a flatter discriminated-union event stream
 * (`SessionEvent`), so the shapes below are a fresh design that preserves the
 * four load-bearing behaviors plan.md calls out: permission-placeholder ↔
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

export interface SubStartItem extends RenderItemBase {
  kind: "sub-start";
}

export interface SubStopItem extends RenderItemBase {
  kind: "sub-stop";
}

/** Live state of a permission request, shared by reference between whatever
 * item currently represents it (a placeholder or the tool it matched) so a
 * later `perm-resolve` updates the right place regardless of match order. */
export interface PermissionInfo {
  reqId: string;
  modes: PermissionMode[];
  decision?: PermDecision;
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
  /** Linked sidechain/subagent scope — envelopes whose `subagent` field
   * equals this tool's `call` id (plan.md §8.2 "subagent/sidechain linking"). */
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
  | SubStartItem
  | SubStopItem
  | PermPlaceholderItem
  | ToolItem
  | OrphanToolEndItem
  | SubagentGroupItem;
