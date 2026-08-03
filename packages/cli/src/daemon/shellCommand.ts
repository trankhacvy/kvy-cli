/**
 * Wraps a free-form script string (`workspaceConfig.ts`'s `setupScript`/
 * `runScript`) into a shell-invocation argv: unlike `processLauncher.ts`'s
 * `launchProviderProcess` (which spawns a known argv with no shell
 * involved), a user-authored script like `"npm install && npm run build"`
 * needs an actual shell to parse `&&`/pipes/env-var expansion, so this is a
 * genuinely new invocation path.
 *
 * POSIX: `/bin/sh -c <script>` (matches `sh`'s POSIX-guaranteed presence —
 * no dependency on the user's interactive shell/its rc files, same
 * reasoning as most CI systems' `run:` steps). Windows: `cmd.exe /c
 * <script>` (the built-in, always-present command interpreter — no `sh`
 * guarantee there). `process.platform` is injectable so both branches are
 * unit-testable on any single CI runner.
 */

export interface ShellInvocation {
  command: string;
  args: string[];
}

/** Builds the `{command, args}` argv that runs `script` under the current platform's shell. */
export function buildShellInvocation(
  script: string,
  platform: NodeJS.Platform = process.platform,
): ShellInvocation {
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/c", script] };
  }
  return { command: "/bin/sh", args: ["-c", script] };
}
