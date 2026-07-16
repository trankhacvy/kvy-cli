import type { PermPlaceholderItem } from "@/sync/reducer";
import { JsonBlock } from "./JsonBlock";
import { PermissionBadge } from "./PermissionBadge";

/** A `perm-request` that never matched a `tool-start` (design principle: no
 * silent data loss — the reducer surfaces it standalone rather than
 * dropping it). Read-only display only; no Allow/Deny actions (Phase 2). */
export function PermPlaceholder({ item }: { item: PermPlaceholderItem }) {
  return (
    <div className="max-w-[85%] rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Permission requested — {item.name}</span>
        <PermissionBadge permission={item.permission} />
      </div>
      {item.args !== undefined && <JsonBlock value={item.args} className="mt-1.5" />}
    </div>
  );
}
