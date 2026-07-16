import type { WorkspaceGroup } from "../group";
import type { SessionListMachine } from "../types";
import { SessionCard } from "./session-card";

export function WorkspaceSection({
  group,
  machinesById,
}: {
  group: WorkspaceGroup;
  machinesById: Map<string, SessionListMachine>;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-sm font-medium text-muted-foreground">{group.workspace.name}</h2>
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
