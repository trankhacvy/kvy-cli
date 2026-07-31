import type { ProviderId } from "@falcon/wire";
import { runStartClaudeCommand } from "../commands/start.js";
import { runStartCodexCommand } from "../commands/startCodex.js";
import type { Logger } from "../logger.js";

export interface StartCommandDeps {
  homeDir: string;
  workingDirectory: string;
  providerArgs: string[];
  logger: Logger;
  launcherPath?: string;
}

const RUN_START: Record<ProviderId, (deps: StartCommandDeps) => Promise<number>> = {
  "claude-code": async (deps) => {
    if (!deps.launcherPath) {
      throw new Error("claude-code start requires launcherPath");
    }
    return runStartClaudeCommand({
      homeDir: deps.homeDir,
      workingDirectory: deps.workingDirectory,
      claudeArgs: deps.providerArgs,
      launcherPath: deps.launcherPath,
      logger: deps.logger,
    });
  },
  codex: (deps) =>
    runStartCodexCommand({
      homeDir: deps.homeDir,
      workingDirectory: deps.workingDirectory,
      codexArgs: deps.providerArgs,
      logger: deps.logger,
    }),
};

export function runStart(id: ProviderId, deps: StartCommandDeps): Promise<number> {
  return RUN_START[id](deps);
}
