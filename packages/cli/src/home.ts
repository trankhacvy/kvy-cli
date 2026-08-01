import { homedir } from "node:os";
import path from "node:path";

/**
 * Every piece of local CLI state (settings, credentials, logs) lives under
 * this directory. `KVY_HOME_DIR` overrides the default so tests and
 * multi-instance dev setups can isolate state instead of colliding on a
 * real `~/.kvy` (design §7.2, plan.md §6.1).
 */
export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KVY_HOME_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(homedir(), ".kvy");
}
