import type { SessionEnvelope } from "@falcon/wire";
import type {
  OrphanToolEndItem,
  PermissionInfo,
  PermPlaceholderItem,
  RenderItem,
  SubagentGroupItem,
  ToolItem,
} from "./types.js";

/**
 * Folds a `SessionEnvelope[]` into an ordered `RenderItem[]`
 * (falcon-system-design.md §9.1, plan.md §8.2). Pure and idempotent: calling
 * it twice on the same (possibly re-fetched, possibly re-ordered) array
 * yields the same result, which is what makes it safe to re-run on every
 * sync merge rather than incrementally patched.
 *
 * Multi-phase, mirroring Happy's `reducer.ts`:
 *   1. dedupe by envelope id (a re-fetch/reconnect merge may repeat ids)
 *   2. stable time-sort
 *   3. partition into scopes by `subagent` id (root scope = no subagent)
 *   4. reduce each scope independently: turn/tool-start/tool-end pairing,
 *      perm-request↔tool-start matching (by `call` if known, else by
 *      name+args), tool-end/perm-resolve applied onto their open item
 *   5. link each subagent scope onto the `ToolItem` whose `call` equals its
 *      subagent id (the adapter convention: a subagent's id is the call id
 *      of the parent Task-like tool that spawned it); scopes that never
 *      match anything are still surfaced as standalone groups
 */
export function reduceEnvelopes(envelopes: SessionEnvelope[]): RenderItem[] {
  const deduped = dedupeById(envelopes);
  const sorted = stableSortByTime(deduped);

  const rootEnvelopes: SessionEnvelope[] = [];
  const subagentOrder: string[] = [];
  const subagentEnvelopes = new Map<string, SessionEnvelope[]>();

  for (const env of sorted) {
    if (env.subagent === undefined) {
      rootEnvelopes.push(env);
      continue;
    }
    const bucket = subagentEnvelopes.get(env.subagent);
    if (bucket) {
      bucket.push(env);
    } else {
      subagentEnvelopes.set(env.subagent, [env]);
      subagentOrder.push(env.subagent);
    }
  }

  const rootItems = reduceScope(rootEnvelopes);
  return linkSubagentScopes(rootItems, subagentOrder, subagentEnvelopes);
}

function dedupeById(envelopes: SessionEnvelope[]): SessionEnvelope[] {
  const seen = new Set<string>();
  const out: SessionEnvelope[] = [];
  for (const env of envelopes) {
    if (seen.has(env.id)) continue;
    seen.add(env.id);
    out.push(env);
  }
  return out;
}

function stableSortByTime<T extends { time: number }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.time - b.item.time || a.index - b.index)
    .map((entry) => entry.item);
}

/** A pending perm-request that arrived without a `call` id and hasn't
 * matched a tool-start yet, keyed by a canonical name+args string. */
interface PendingPlaceholder {
  placeholder: PermPlaceholderItem;
  argsKey: string;
}

/** Reduces a single scope's (already time-sorted) envelopes into items.
 * Tool-start/tool-end pairing and perm matching are scoped here — a
 * subagent's tool calls never pair against the root scope's, and vice
 * versa. */
function reduceScope(envs: SessionEnvelope[]): RenderItem[] {
  const items: RenderItem[] = [];
  const toolByCall = new Map<string, ToolItem>();
  const permInfoByReqId = new Map<string, PermissionInfo>();
  const pendingPermByCall = new Map<string, PermissionInfo>();
  const pendingPlaceholders: PendingPlaceholder[] = [];

  for (const env of envs) {
    const ev = env.ev;
    const base = { id: env.id, time: env.time, role: env.role, turn: env.turn };

    switch (ev.t) {
      case "text":
        items.push({ ...base, kind: "text", md: ev.md, thinking: ev.thinking ?? false });
        break;

      case "service":
        items.push({ ...base, kind: "service", text: ev.text });
        break;

      case "file":
        items.push({
          ...base,
          kind: "file",
          ref: ev.ref,
          name: ev.name,
          size: ev.size,
          image: ev.image,
        });
        break;

      case "turn-start":
        items.push({ ...base, kind: "turn-start" });
        break;

      case "turn-end":
        items.push({ ...base, kind: "turn-end", status: ev.status });
        break;

      case "mode-switch":
        items.push({ ...base, kind: "mode-switch", control: ev.control, by: ev.by });
        break;

      case "permission-mode":
        items.push({ ...base, kind: "permission-mode", mode: ev.mode, source: ev.source });
        break;

      case "sub-start":
        items.push({ ...base, kind: "sub-start" });
        break;

      case "sub-stop":
        items.push({ ...base, kind: "sub-stop" });
        break;

      case "usage":
        items.push({
          ...base,
          kind: "usage",
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          costUsd: ev.costUsd,
        });
        break;

      case "perm-request": {
        const info: PermissionInfo = { reqId: ev.reqId, modes: ev.modes };
        permInfoByReqId.set(ev.reqId, info);

        if (ev.call !== undefined) {
          // The adapter already knows which tool call this permission is for.
          const existingTool = toolByCall.get(ev.call);
          if (existingTool) {
            existingTool.permission = info;
          } else {
            pendingPermByCall.set(ev.call, info);
          }
          break;
        }

        // No call id yet — render a placeholder, fall back to matching the
        // eventual tool-start by name+args (plan.md §8.2).
        const placeholder: PermPlaceholderItem = {
          ...base,
          kind: "perm-placeholder",
          name: ev.name,
          args: ev.args,
          permission: info,
        };
        items.push(placeholder);
        pendingPlaceholders.push({ placeholder, argsKey: canonicalArgsKey(ev.name, ev.args) });
        break;
      }

      case "perm-resolve": {
        const info = permInfoByReqId.get(ev.reqId);
        if (info) info.decision = ev.decision;
        break;
      }

      case "tool-start": {
        let permission = pendingPermByCall.get(ev.call);
        if (permission) {
          pendingPermByCall.delete(ev.call);
        }

        let matchedIndex = -1;
        if (!permission) {
          const argsKey = canonicalArgsKey(ev.name, ev.args);
          matchedIndex = pendingPlaceholders.findIndex((p) => p.argsKey === argsKey);
          if (matchedIndex !== -1) {
            permission = pendingPlaceholders[matchedIndex]?.placeholder.permission;
          }
        }

        const tool: ToolItem = {
          ...base,
          kind: "tool",
          call: ev.call,
          name: ev.name,
          title: ev.title,
          args: ev.args,
          risk: ev.risk,
          status: "running",
          permission,
        };
        toolByCall.set(ev.call, tool);

        if (matchedIndex !== -1) {
          const pending = pendingPlaceholders[matchedIndex];
          pendingPlaceholders.splice(matchedIndex, 1);
          const pos = pending ? items.indexOf(pending.placeholder) : -1;
          if (pos !== -1) {
            items[pos] = tool;
          } else {
            items.push(tool);
          }
        } else {
          items.push(tool);
        }
        break;
      }

      case "tool-end": {
        const tool = toolByCall.get(ev.call);
        if (tool) {
          tool.status = "done";
          tool.ok = ev.ok;
          tool.output = ev.output;
        } else {
          const orphan: OrphanToolEndItem = {
            ...base,
            kind: "orphan-tool-end",
            call: ev.call,
            ok: ev.ok,
            output: ev.output,
          };
          items.push(orphan);
        }
        break;
      }
    }
  }

  return items;
}

/** Attaches each subagent scope onto the `ToolItem` whose `call` equals its
 * subagent id, searching the whole tree built so far (including previously
 * linked nested subagents) so linking order never matters. Scopes with no
 * match are appended as standalone groups, time-sorted alongside the root. */
function linkSubagentScopes(
  rootItems: RenderItem[],
  order: string[],
  envelopesByScope: Map<string, SessionEnvelope[]>,
): RenderItem[] {
  const standalone: SubagentGroupItem[] = [];

  for (const subagentId of order) {
    const envs = envelopesByScope.get(subagentId);
    const first = envs?.[0];
    if (!envs || !first) continue;

    const childItems = reduceScope(envs);
    const parentTool =
      findToolByCall(rootItems, subagentId) ?? findToolByCall(standalone, subagentId);

    if (parentTool) {
      parentTool.subagent = childItems;
    } else {
      standalone.push({
        id: first.id,
        time: first.time,
        role: first.role,
        turn: first.turn,
        kind: "subagent-group",
        subagentId,
        items: childItems,
      });
    }
  }

  if (standalone.length === 0) return rootItems;
  return stableSortByTime([...rootItems, ...standalone]);
}

function findToolByCall(items: RenderItem[], call: string): ToolItem | undefined {
  for (const item of items) {
    if (item.kind === "tool") {
      if (item.call === call) return item;
      if (item.subagent) {
        const found = findToolByCall(item.subagent, call);
        if (found) return found;
      }
    } else if (item.kind === "subagent-group") {
      const found = findToolByCall(item.items, call);
      if (found) return found;
    }
  }
  return undefined;
}

/** Deterministic name+args key, independent of object key insertion order —
 * a permission request and its matching tool-start may serialize args
 * differently upstream even when logically identical. */
function canonicalArgsKey(name: string, args: unknown): string {
  return `${name}::${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
