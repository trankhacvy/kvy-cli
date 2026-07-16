import { Badge } from "@/components/ui/badge";
import type { PermissionInfo } from "@/sync/reducer";

/** Read-only permission status indicator (falcon-prd.md FR-7.2 "permission
 * events"). No Allow/Deny actions here — the interactive `PermCard` is
 * Phase 2 (plan.md §8.4); this just shows what already happened. */
export function PermissionBadge({ permission }: { permission: PermissionInfo }) {
  const decision = permission.decision;

  if (!decision) {
    return <Badge variant="warning">Permission pending</Badge>;
  }

  if (decision.kind === "allow") {
    return (
      <Badge variant="success">Allowed{decision.scope === "session" ? " (session)" : ""}</Badge>
    );
  }

  if (decision.kind === "deny") {
    return (
      <Badge variant="destructive">Denied{decision.message ? `: ${decision.message}` : ""}</Badge>
    );
  }

  return <Badge variant="secondary">Mode → {decision.mode}</Badge>;
}
