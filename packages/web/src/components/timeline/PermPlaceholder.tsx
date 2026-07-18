import { isAskUserQuestion } from "@/lib/tool-args";
import type { PermPlaceholderItem } from "@/sync/reducer";
import { AskUserQuestionCard } from "./AskUserQuestionCard";
import { JsonBlock } from "./JsonBlock";
import { PermCard } from "./PermCard";
import { PermissionBadge } from "./PermissionBadge";

/** A `perm-request` that never matched a `tool-start` (design principle: no
 * silent data loss — the reducer surfaces it standalone rather than
 * dropping it). Interactive once a decision is pending (`PermCard`, plan.md
 * §16 "2.4 Web control surface"); already-decided requests keep the
 * read-only `PermissionBadge` + a raw args dump, since `PermCard` only
 * bothers with the edit-preview rendering while a decision is still pending.
 * `AskUserQuestion` (plan-v2.md W2.1) dispatches to its own card instead —
 * that card handles its own pending/answered/lost-race states internally,
 * so it's routed here regardless of `permission.decision`. */
export function PermPlaceholder({ item }: { item: PermPlaceholderItem }) {
  if (isAskUserQuestion(item.name)) {
    return <AskUserQuestionCard args={item.args} permission={item.permission} />;
  }

  if (item.permission.decision === undefined) {
    return <PermCard name={item.name} args={item.args} permission={item.permission} />;
  }

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
