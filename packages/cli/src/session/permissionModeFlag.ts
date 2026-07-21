import type { PermissionMode } from "@falcon/wire";
import { PermissionModeSchema } from "@falcon/wire";

/**
 * Pulls a `--permission-mode <value>` (or `--permission-mode=value`)
 * override out of a passthrough args array (`falcon claude [args...]`'s full
 * flag passthrough) — the same real Claude Code flag `daemon/spawnEngine.ts`
 * passes for a daemon-spawned session (`--permission-mode`,
 * `packages/wire/src/permissions.ts`'s `PermissionModeSchema`).
 *
 * Used to seed `PreToolPermissionBridge`'s `lastPermissionMode` baseline
 * (docs/bug-fix-plan.md issue #5's known gap): without a real starting mode
 * to compare against, the bridge's first hook echo — which may already
 * reflect a mode the user switched to via Shift+Tab before ever using a
 * tool — is indistinguishable from "no transition happened," so the web
 * mode chip silently never catches up until a second, unrelated switch.
 * Seeding from the actual launch flag (falling back to `"default"`, Claude
 * Code's own default when no flag is given) gives the first hook echo a
 * real baseline to compare against instead of `null`.
 *
 * An unrecognized value (anything `PermissionModeSchema` rejects) is treated
 * the same as "no flag given" rather than trusted — mirrors
 * `cachePermissionMode`'s own "ignore anything `PERMISSION_MODE_CYCLE` can't
 * index" rule for hook-observed values.
 *
 * Last occurrence wins, matching `extractModelFlag`'s resolution for a
 * repeated flag.
 */
export function extractPermissionModeFlag(args: string[]): PermissionMode | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--permission-mode") {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        found = value;
        i++;
      }
      continue;
    }
    if (arg.startsWith("--permission-mode=")) {
      found = arg.slice("--permission-mode=".length);
    }
  }
  if (found === undefined) return undefined;
  const parsed = PermissionModeSchema.safeParse(found);
  return parsed.success ? parsed.data : undefined;
}
