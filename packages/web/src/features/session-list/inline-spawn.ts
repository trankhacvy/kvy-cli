import type { PermissionMode } from "@falcon/wire";
import type { BranchItem, ImportCandidate, NewSessionProvider, SpawnRequest } from "../new-session";

/**
 * Pure form/derivation logic for the workspace-row `+` inline creation panel
 * (B2-B4, new-session-from-web redesign — see the task's own header
 * comment). No React, no RPC — mirrors this codebase's house style for
 * screen-adjacent derivation logic (`group.ts`, `target-machine.ts`,
 * `new-session/wizard-state.ts`), and is what actually distinguishes this
 * new panel from the old wizard's `NewSessionForm`: there is no
 * machine/directory step (both are always already known — B1) and no
 * repo-root/existing-branch choice (every spawn from here always creates a
 * fresh worktree on a fresh branch off a base ref — the product decision in
 * this task's header comment).
 */

export interface InlineSpawnForm {
  provider: NewSessionProvider;
  permissionMode: PermissionMode;
  /** Free-text model override; `""` means "use the provider's default" — same convention as the old wizard's `NewSessionForm.model`. */
  model: string;
  /** The new branch's base ref (`""` falls back to whatever's currently checked out — `git.branches`' own default). */
  baseBranch: string;
  /** The new branch's own name — always populated; auto-generated on panel open, editable. */
  branchName: string;
  /** Set when "Continue from a recent session" (the old wizard's `ImportStep`, folded into this panel's Advanced disclosure — B5) picked a candidate; `null` starts fresh. */
  continueFrom: ImportCandidate | null;
}

/**
 * Resolves the base-branch picker's initial selection: prefers the
 * workspace's configured base ref (`workspace.getConfig`'s
 * `WorkspaceGitConfig.baseRef`, set via `falcon workspace config
 * --base-ref <ref>`) when one's been set; otherwise falls back to whichever
 * local branch `git.branches` reports as `isCurrent` for the workspace's own
 * repo root, and finally to the literal `"main"` when branches haven't
 * loaded yet or none is marked current (a bare/detached-HEAD repo, or the
 * list is still `null` because the picker hasn't been opened/fetched yet).
 * `branchOptionFromForm`-equivalent spawn-request building always sends
 * this through as `from`, and the daemon's `gitWorktree.ts` only consults
 * `from` on the branch-doesn't-exist path, ignoring it entirely once a real
 * base is picked from the picker.
 */
export function deriveDefaultBaseBranch(
  branches: BranchItem[] | null,
  configuredBaseRef?: string,
): string {
  if (configuredBaseRef && configuredBaseRef.trim() !== "") return configuredBaseRef;
  const current = branches?.find((b) => b.isCurrent)?.name;
  return current ?? "main";
}

/**
 * Builds the `spawn` RPC request for `directory` (a workspace's own
 * registered id/path — B1's "workspaceId IS a directory path" convention)
 * from the panel's form state. Unlike the old wizard's
 * `wizard-state.ts#buildSpawnRequest`, `branch` is never optional and
 * `createWorktree` is never anything but `true` — B3's product decision:
 * every session from this entry point gets a fresh worktree on a fresh
 * branch, always, no repo-root/existing-branch modes to choose between.
 */
export function buildInlineSpawnRequest(directory: string, form: InlineSpawnForm): SpawnRequest {
  const model = form.model.trim();
  const from = form.baseBranch.trim();
  return {
    directory,
    provider: form.provider,
    permissionMode: form.permissionMode,
    model: model === "" ? undefined : model,
    branch: {
      name: form.branchName.trim(),
      createWorktree: true,
      from: from === "" ? undefined : from,
    },
    continueFrom: form.continueFrom
      ? { providerSessionId: form.continueFrom.providerSessionId }
      : undefined,
  };
}

/** Whether the panel's "Start session" button should be enabled — the only hard requirement is a non-blank branch name (`gitWorktree.ts`'s `assertSafeBranchName` rejects blank/unsafe names daemon-side; catching the empty case here avoids a round-trip just to learn that). */
export function canStartInlineSpawn(form: InlineSpawnForm): boolean {
  return form.branchName.trim() !== "";
}

/**
 * Translates a raw spawn-failure message (from `MachineRpcError`/
 * `SpawnFlowError`/a plain thrown `Error`, all of which end up as
 * `err.message` at the panel's call site) into honest, plain-language copy
 * (B4). Phase A's daemon-side work (`spawnAwaiter.ts`, `spawnEngine.ts`,
 * `gitWorktree.ts`) means the raw message can now be one of several
 * distinguishable shapes — see each branch's comment for the exact source —
 * rather than always the old flat "did not report back" timeout string.
 *
 * Every branch's OWN copy is already pid/route-name-free by construction;
 * the final `scrub` pass is defense-in-depth for whatever unrecognized
 * message reaches the `default` case (e.g. a future daemon error shape this
 * function hasn't been taught yet) — never surface a raw pid or the
 * `/session-started`/`/session-start-failed` webhook route names verbatim,
 * per this task's own instruction.
 */
export function translateSpawnError(raw: string): string {
  // `spawnAwaiter.ts`: the flat 15s timeout — the process is still apparently
  // running but never reported back.
  if (/did not report back via \/session-started/i.test(raw)) {
    return "Timed out waiting for the session to start. The machine may be slow, asleep, or unreachable right now. Try again in a moment.";
  }

  // `spawnAwaiter.ts`'s exit-watcher (A3): the child process was observed to
  // exit before it ever reported starting.
  if (/exited before it reported starting/i.test(raw)) {
    return "The session process exited before it could start. Check that machine's `falcon` logs for what went wrong.";
  }

  // `spawnAwaiter.ts`'s `/session-start-failed` self-report (A4) — the
  // child's own observed error, e.g. a 429 session-quota rejection or an
  // ACP adapter that still failed even after an auto-install attempt.
  const startupFailure = raw.match(/reported a startup failure: (.*)$/i);
  if (startupFailure?.[1]) {
    const detail = startupFailure[1];
    if (/\b429\b|quota/i.test(detail)) {
      return "This account has hit its session limit on that machine. Stop another session there first, or wait a bit and try again.";
    }
    if (/adapter/i.test(detail) || /not[- ]installed/i.test(detail)) {
      return "That machine needed to install a provider adapter first and it didn't finish in time. Try again in a moment, or run `falcon adapters install` there directly if it keeps failing.";
    }
    return `The session failed to start: ${detail}`;
  }

  // `gitWorktree.ts`, surfaced via `spawnEngine.ts`'s `SpawnError` wrapper.
  const worktreeFailure = raw.match(/branch\/worktree setup failed: (.*)$/i);
  if (worktreeFailure?.[1]) {
    return `Couldn't set up the branch/worktree: ${worktreeFailure[1]}`;
  }

  // `processLauncher.ts`, surfaced via `spawnEngine.ts`'s `SpawnError` wrapper.
  const launchFailure = raw.match(/failed to launch provider process: (.*)$/i);
  if (launchFailure?.[1]) {
    return `Couldn't launch the session on that machine: ${launchFailure[1]}`;
  }

  // `workspacePath.ts`'s validation — should be structurally unreachable for
  // this entry point (see `use-inline-spawn.ts`'s own doc comment), but
  // translated honestly rather than left as a raw internal reason code if it
  // somehow is reached.
  if (/workspace path rejected/i.test(raw)) {
    return "That workspace's directory couldn't be validated on the target machine. It may have been moved, renamed, or deleted.";
  }

  // Unrecognized shape — pass the message through, but scrub any raw pid or
  // webhook route name defensively before showing it.
  return raw
    .replace(/\(pid \d+[^)]*\)/gi, "")
    .replace(/\/session-started/gi, "the session-start signal")
    .replace(/\/session-start-failed/gi, "the session-start-failure signal")
    .replace(/\s{2,}/g, " ")
    .trim();
}
