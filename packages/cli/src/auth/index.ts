import type { Logger } from "../logger.js";
import { runAuthLogin } from "./login.js";
import { runAuthLogout } from "./logout.js";
import { runAuthStatus } from "./status.js";

export type AuthAction = "login" | "logout" | "status";

export async function runAuthCommand(action: AuthAction, logger: Logger): Promise<number> {
  switch (action) {
    case "login":
      return runAuthLogin(logger);
    case "logout":
      return runAuthLogout(logger);
    case "status":
      return runAuthStatus();
  }
}
