import type { NewSessionActions, SpawnRequest } from "./types";

/**
 * Orchestrates `spawn`'s two approval loops (plan.md §16 "3.1 Remote
 * spawn" and "Flow 3 — spawn-fresh-folder-register (Piece A)"): call
 * `spawn`; if the daemon reports it needs an approval first
 * (`requiresApproval`), ask the caller to confirm, resolve it — create the
 * directory (`fs.mkdir`) for `"create-directory"`, or register the
 * workspace (`workspace.register`) for `"register-workspace"` — and retry
 * `spawn` once more. Pulled out of the screen component so the loop itself
 * — the part with actual branching logic — is unit-testable without React
 * (mirrors `features/session-control`'s `perm-card-state.ts` split between
 * pure logic and presentation).
 */
export type SpawnFlowResult = { outcome: "spawned"; sessionId: string } | { outcome: "declined" };

/** Thrown only when the daemon still reports the same approval needed right after resolving it — `fs.mkdir` is `mkdir -p` and `workspace.register` is idempotent, so either case means something unexpected changed on the machine between the two calls. */
export class SpawnFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnFlowError";
  }
}

export async function runSpawnFlow(
  actions: Pick<NewSessionActions, "spawn" | "createDirectory" | "registerWorkspace">,
  request: SpawnRequest,
  confirmApproval: (
    directory: string,
    action: "create-directory" | "register-workspace",
  ) => Promise<boolean>,
): Promise<SpawnFlowResult> {
  const first = await actions.spawn(request);
  if (first.type === "success") {
    return { outcome: "spawned", sessionId: first.sessionId };
  }

  const approved = await confirmApproval(first.directory, first.action);
  if (!approved) {
    return { outcome: "declined" };
  }

  if (first.action === "register-workspace") {
    await actions.registerWorkspace(first.directory);
  } else {
    await actions.createDirectory(first.directory);
  }

  const retried = await actions.spawn(request);
  if (retried.type === "success") {
    return { outcome: "spawned", sessionId: retried.sessionId };
  }

  throw new SpawnFlowError(
    `${first.action === "register-workspace" ? "workspace still unregistered" : "directory still reported missing"} after resolving it: ${retried.directory}`,
  );
}
