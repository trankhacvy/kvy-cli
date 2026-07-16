import type { NewSessionActions, SpawnRequest } from "./types";

/**
 * Orchestrates the "409 directory-creation approval loop" (plan.md §16
 * "3.1 Remote spawn"): call `spawn`; if the daemon reports the directory
 * doesn't exist yet (`requiresApproval`), ask the caller to confirm, create
 * it (`fs.mkdir`), and retry `spawn` once more. Pulled out of the screen
 * component so the loop itself — the part with actual branching logic — is
 * unit-testable without React (mirrors `features/session-control`'s
 * `perm-card-state.ts` split between pure logic and presentation).
 */
export type SpawnFlowResult = { outcome: "spawned"; sessionId: string } | { outcome: "declined" };

/** Thrown only when the daemon still reports the directory missing right after `createDirectory` resolved — `fs.mkdir` is `mkdir -p`, so this means something unexpected changed on the machine between the two calls. */
export class SpawnFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnFlowError";
  }
}

export async function runSpawnFlow(
  actions: Pick<NewSessionActions, "spawn" | "createDirectory">,
  request: SpawnRequest,
  confirmCreateDirectory: (directory: string) => Promise<boolean>,
): Promise<SpawnFlowResult> {
  const first = await actions.spawn(request);
  if (first.type === "success") {
    return { outcome: "spawned", sessionId: first.sessionId };
  }

  const approved = await confirmCreateDirectory(first.directory);
  if (!approved) {
    return { outcome: "declined" };
  }

  await actions.createDirectory(first.directory);
  const retried = await actions.spawn(request);
  if (retried.type === "success") {
    return { outcome: "spawned", sessionId: retried.sessionId };
  }

  throw new SpawnFlowError(
    `directory still reported missing after creating it: ${retried.directory}`,
  );
}
