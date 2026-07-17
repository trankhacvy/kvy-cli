/**
 * `falcon daemon service install/uninstall/status` (falcon-prd.md FR-4.1,
 * falcon-system-design.md §8 "Service install (P1)", plan.md §16 "4.3
 * Distribution & self-host"). Thin CLI wiring over
 * `../daemon/serviceInstall.ts` — see that module for the actual
 * launchd/systemd logic.
 */
import {
  installService,
  type ServiceCommandDeps,
  serviceStatus,
  uninstallService,
} from "../daemon/serviceInstall.js";
import type { ServiceInstallOptions } from "../daemon/serviceInstallPaths.js";

export type ServiceCommandAction = "install" | "uninstall" | "status";

export interface RunServiceCommandDeps {
  serviceOptions?: ServiceInstallOptions;
  /** Injectable `launchctl`/`systemctl` runner — test seam, see `daemon/serviceInstall.ts`. */
  serviceDeps?: ServiceCommandDeps;
  write?: (text: string) => void;
}

export async function runDaemonServiceCommand(
  action: ServiceCommandAction,
  deps: RunServiceCommandDeps = {},
): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const options = deps.serviceOptions ?? {};
  const serviceDeps = deps.serviceDeps ?? {};

  const result = await (action === "install"
    ? installService(options, serviceDeps)
    : action === "uninstall"
      ? uninstallService(options, serviceDeps)
      : serviceStatus(options, serviceDeps));

  write(result.message);
  return result.ok ? 0 : 1;
}
