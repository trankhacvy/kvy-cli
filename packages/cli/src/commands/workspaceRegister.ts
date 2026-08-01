/**
 * `kvy workspace register [--directory <path>] [--name <display-name>]`
 * `kvy workspace list`
 * `kvy workspace unregister [--directory <path>]`
 *
 * Terminal-side surface for `../workspace/registry.ts` (plan.md §16 "3.1
 * Remote spawn" / "3.3 Session adoption (UC9)"). `--directory` defaults to
 * the current working directory for both `register` and `unregister`,
 * matching Omnara's low-friction UX per the PRD — `kvy workspace
 * register` with no flags just registers "here". No daemon interaction:
 * this reads/writes `~/.kvy/workspaces.json` directly, same rationale as
 * `commands/workspaceConfig.ts` skipping `ensureDaemon()`.
 */
import type { RegisteredWorkspaceEntry, RegistryOptions } from "../workspace/registry.js";
import { listWorkspaces, registerWorkspace, unregisterWorkspace } from "../workspace/registry.js";

export interface WorkspaceRegisterCommandOptions {
  directory?: string;
  name?: string;
}

export interface WorkspaceUnregisterCommandOptions {
  directory?: string;
}

export interface WorkspaceRegistryCommandDeps {
  workingDirectory: string;
  registryOptions?: RegistryOptions;
  write?: (text: string) => void;
}

function describeEntry(entry: RegisteredWorkspaceEntry): string {
  const name = entry.displayName ? ` "${entry.displayName}"` : "";
  return `${entry.path}${name} (registered ${entry.registeredAt})`;
}

/** Runs `kvy workspace register`. Always returns 0 — registering an already-registered directory just updates its display name (or is a no-op). */
export async function runWorkspaceRegisterCommand(
  options: WorkspaceRegisterCommandOptions,
  deps: WorkspaceRegistryCommandDeps,
): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const directory = options.directory ?? deps.workingDirectory;

  const entry = await registerWorkspace(
    directory,
    options.name !== undefined ? { displayName: options.name } : {},
    deps.registryOptions,
  );
  write(`kvy workspace register: registered ${describeEntry(entry)}\n`);
  return 0;
}

/** Runs `kvy workspace list`. */
export async function runWorkspaceListCommand(deps: WorkspaceRegistryCommandDeps): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const entries = await listWorkspaces(deps.registryOptions);

  if (entries.length === 0) {
    write("kvy workspace list: no registered workspaces\n");
    return 0;
  }
  for (const entry of entries) write(`${describeEntry(entry)}\n`);
  return 0;
}

/** Runs `kvy workspace unregister`. Returns 1 if `directory` wasn't registered, so scripting can detect a no-op — never throws. */
export async function runWorkspaceUnregisterCommand(
  options: WorkspaceUnregisterCommandOptions,
  deps: WorkspaceRegistryCommandDeps,
): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const directory = options.directory ?? deps.workingDirectory;

  const removed = await unregisterWorkspace(directory, deps.registryOptions);
  if (removed) {
    write(`kvy workspace unregister: removed ${directory}\n`);
    return 0;
  }
  write(`kvy workspace unregister: ${directory} was not registered\n`);
  return 1;
}
