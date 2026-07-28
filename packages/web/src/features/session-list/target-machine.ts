import type { WorkspaceGroup } from "./group";

/**
 * B1 (new-session-from-web redesign — see the task's own header comment):
 * derives which machine a workspace's `+` "start a new session here" action
 * should target. The server's `workspaces` table has no `machineId` column
 * (a workspace's machine association isn't first-class server data today —
 * `packages/server/src/db/schema.ts`), and this whole feature's precondition
 * is "the user already has at least one session in this workspace" (the old
 * free-form directory wizard is retired — B5), so the target machine is
 * derived from the workspace group's OWN sessions rather than adding new
 * server plumbing: each `SessionListSession` already carries a real
 * `machineId` (`types.ts`).
 *
 * Pure, no React, no RPC — mirrors this codebase's house style for
 * screen-adjacent derivation logic (`group.ts`, `new-session/wizard-state.ts`).
 */

/** One machine that has run at least one session in a workspace group, with the most-recent `updatedAt` among that machine's sessions there. */
export interface WorkspaceTargetMachine {
  machineId: string;
  /** The most recent `updatedAt` of any session in this group that ran on this machine. */
  lastActiveAt: number;
}

/**
 * Every distinct machine referenced by `group`'s sessions, most-recently-
 * active first. Sessions with a `null` machineId (shouldn't happen for a
 * session that's actually run, but `SessionListSession.machineId` is
 * nullable) are excluded — there is no machine to target for them, and they
 * must not silently produce a bogus target.
 */
export function deriveWorkspaceTargetMachines(group: WorkspaceGroup): WorkspaceTargetMachine[] {
  const lastActiveByMachine = new Map<string, number>();
  for (const session of group.sessions) {
    if (session.machineId === null) continue;
    const current = lastActiveByMachine.get(session.machineId);
    if (current === undefined || session.updatedAt > current) {
      lastActiveByMachine.set(session.machineId, session.updatedAt);
    }
  }
  return [...lastActiveByMachine.entries()]
    .map(([machineId, lastActiveAt]) => ({ machineId, lastActiveAt }))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

/**
 * Whether the workspace's `+` action needs to ask which machine to target
 * (a lightweight inline choice, not the old wizard's heavy first step) —
 * true only when the group's sessions genuinely span more than one distinct
 * machine (e.g. the same path was used on two different paired machines).
 */
export function workspaceNeedsMachineChoice(group: WorkspaceGroup): boolean {
  return deriveWorkspaceTargetMachines(group).length > 1;
}

/**
 * The `+` action's default target machine: the most-recently-active one
 * among the group's sessions. `null` only for a workspace group with no
 * session carrying a resolvable `machineId` at all — shouldn't happen in
 * practice (this feature's precondition is "at least one session already
 * ran here"), but handled honestly rather than assumed, so a caller can
 * decide how to degrade (e.g. disable the `+` button) instead of silently
 * targeting nothing.
 */
export function deriveDefaultTargetMachineId(group: WorkspaceGroup): string | null {
  return deriveWorkspaceTargetMachines(group)[0]?.machineId ?? null;
}
