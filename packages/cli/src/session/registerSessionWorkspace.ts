import type { Logger } from "../logger.js";
import { registerWorkspace as registerWorkspaceDefault } from "../workspace/registry.js";

export interface RegisterSessionWorkspaceDeps {
  registerWorkspace?: typeof registerWorkspaceDefault;
  logger: Logger;
}

export async function registerSessionWorkspace(
  workingDirectory: string,
  deps: RegisterSessionWorkspaceDeps,
): Promise<string | null> {
  const doRegisterWorkspace = deps.registerWorkspace ?? registerWorkspaceDefault;
  try {
    const entry = await doRegisterWorkspace(workingDirectory);
    return entry.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn("[register-session-workspace] failed, continuing without workspaceId", {
      message,
    });
    return null;
  }
}
