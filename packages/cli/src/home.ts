import { homedir } from "node:os";
import path from "node:path";

/** `KVY_HOME_DIR` overrides the default so tests and multi-instance dev setups can isolate state instead of colliding on a real `~/.kvy`. */
export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KVY_HOME_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(homedir(), ".kvy");
}
