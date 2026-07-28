"use client";

import { UNGROUPED_WORKSPACE_ID, type WorkspaceGroup } from "../group";
import type { SessionListMachine } from "../types";
import { NewSessionTrigger } from "./new-session-panel";
import { SessionCard } from "./session-card";

/**
 * B2 (new-session-from-web redesign, see the task's own header comment): the
 * `+` "start a new session here" trigger only renders for a REAL workspace
 * row — never for the `UNGROUPED_WORKSPACE_ID` pseudo-workspace `group.ts`
 * synthesizes for sessions with no resolvable `workspaceId` ("Other
 * sessions"). That bucket isn't a real, registered directory anywhere, so
 * there is nothing a `spawn` RPC could target for it.
 */
export function WorkspaceSection({
  group,
  machinesById,
}: {
  group: WorkspaceGroup;
  machinesById: Map<string, SessionListMachine>;
}) {
  const isRealWorkspace = group.workspace.id !== UNGROUPED_WORKSPACE_ID;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-1 px-1">
        <h2 className="text-sm font-medium text-muted-foreground">{group.workspace.name}</h2>
        {isRealWorkspace && <NewSessionTrigger group={group} machinesById={machinesById} />}
      </div>
      <div className="flex flex-col gap-2">
        {group.sessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            machine={session.machineId ? (machinesById.get(session.machineId) ?? null) : null}
          />
        ))}
      </div>
    </section>
  );
}
