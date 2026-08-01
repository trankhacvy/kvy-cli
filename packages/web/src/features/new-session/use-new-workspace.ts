"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { translateSpawnError } from "@/features/session-list";
import { useLiveNewSessionActions } from "./live-source";
import { buildWorkspacePath } from "./new-workspace";
import { runSpawnFlow } from "./spawn-flow";
import type { NewSessionActions, SpawnRequest } from "./types";

/**
 * Creates a brand-new project folder on `machineId`, registers it as a
 * workspace, and spawns the first session in it — the web's answer to "an
 * account with machines but no sessions has nowhere to click"
 * (`features/session-list/session-list-screen.tsx`'s own honest note about
 * that gap, and CLAUDE.md auth/UX rule #1: never print "run X" when you can
 * run X).
 *
 * Adds NO new RPC: `fs.mkdir` (`create-directory`) and `workspace.register`
 * (`register-workspace`) are the exact two approval branches `spawn`
 * already defines (`@kvy/wire`'s `SpawnResult.requiresApproval`), and
 * `spawn-flow.ts`'s `runSpawnFlow` already orchestrates them. The only
 * thing missing was a caller willing to APPROVE: the two existing call
 * sites (`use-inline-spawn.ts`, `use-review-spawn.ts`) both hard-decline,
 * correctly, because for their entry points a fresh folder is structurally
 * impossible.
 *
 * Both approvals are resolved UP FRONT rather than by letting `runSpawnFlow`
 * discover them, because `runSpawnFlow` retries `spawn` exactly ONCE before
 * throwing `SpawnFlowError` — and a genuinely fresh path needs BOTH a
 * directory and a registration. Both calls are idempotent by contract
 * (`fsBrowse.ts`'s `mkdir -p`, `workspace/registry.ts`'s
 * register-twice-is-a-no-op), so doing them eagerly costs one round trip
 * each and can never do harm. `runSpawnFlow` is still used for the spawn
 * itself, as a fallback for anything that changed underneath us.
 */
export type NewWorkspaceState =
  | { phase: "idle" }
  | { phase: "creating"; step: "folder" | "registering" | "starting" }
  | { phase: "success"; sessionId: string; directory: string }
  | { phase: "error"; message: string };

export type CreateWorkspaceOutcome =
  | { outcome: "success"; sessionId: string; directory: string }
  | { outcome: "spawn-failed"; directory: string };

/**
 * The actual folder -> register -> spawn orchestration, pulled out of the
 * hook so it's directly unit-testable without React (this package's vitest
 * has no jsdom, so a hook's internal `useEffect`-fed `home` state can never
 * be driven in a test — same split `spawn-flow.ts`'s own `runSpawnFlow`
 * models: the hook stays thin wiring, the actual branching logic is a
 * plain async function). Throws whatever `createDirectory`/
 * `registerWorkspace`/`spawn` throw; the caller (the hook, below) is
 * responsible for translating that into display copy.
 */
export async function performCreateWorkspace(
  actions: Pick<NewSessionActions, "createDirectory" | "registerWorkspace" | "spawn">,
  directory: string,
  request: Omit<SpawnRequest, "directory">,
  onStep: (step: "folder" | "registering" | "starting") => void,
): Promise<CreateWorkspaceOutcome> {
  onStep("folder");
  await actions.createDirectory(directory);

  onStep("registering");
  await actions.registerWorkspace(directory);

  onStep("starting");
  const result = await runSpawnFlow(actions, { ...request, directory }, async () => true);

  if (result.outcome === "spawned") {
    return { outcome: "success", sessionId: result.sessionId, directory };
  }
  return { outcome: "spawn-failed", directory };
}

export function useNewWorkspace(machineId: string) {
  const actions = useLiveNewSessionActions(machineId);
  const [home, setHome] = useState<string | null>(null);
  const [state, setState] = useState<NewWorkspaceState>({ phase: "idle" });
  const generation = useRef(0);

  // One `fs.list` with no `path`, purely to learn where this machine's home
  // directory is — NOT a browsing UI. `fsBrowse.ts` defaults to `homedir()`
  // and echoes back the resolved absolute path, which is the only reliable
  // way for the web to know whether it's `/Users/x`, `/home/x`, or
  // something else entirely.
  useEffect(() => {
    let cancelled = false;
    setHome(null);
    actions
      .browseDirectory()
      .then((listing) => {
        if (!cancelled) setHome(listing.path);
      })
      .catch(() => {
        // Leave `home` null — the panel renders "couldn't reach that
        // machine" and the create button stays disabled. Never guess a path.
      });
    return () => {
      cancelled = true;
    };
  }, [actions]);

  const create = useCallback(
    (name: string, request: Omit<SpawnRequest, "directory">) => {
      if (home === null) return;
      const myGeneration = ++generation.current;
      const directory = buildWorkspacePath(home, name);

      void performCreateWorkspace(actions, directory, request, (step) => {
        if (generation.current === myGeneration) setState({ phase: "creating", step });
      })
        .then((result) => {
          if (generation.current !== myGeneration) return;
          if (result.outcome === "success") {
            setState({ phase: "success", sessionId: result.sessionId, directory });
            return;
          }
          setState({ phase: "error", message: "Couldn't start a session in the new project." });
        })
        .catch((err: unknown) => {
          if (generation.current !== myGeneration) return;
          const raw = err instanceof Error ? err.message : String(err);
          setState({ phase: "error", message: translateSpawnError(raw) });
        });
    },
    [actions, home],
  );

  const reset = useCallback(() => {
    generation.current++;
    setState({ phase: "idle" });
  }, []);

  return { home, state, create, reset };
}
