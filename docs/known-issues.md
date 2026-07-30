# Known issues

Tracks open issues found during testing/planning — why it's parked and what a real fix
needs. Resolved issues are removed once verified rather than kept as a growing archive;
history for anything previously listed here lives in git (this file's own commit log) and,
for the flows-3/4/5 track, in `docs/plan-flows-3-4-5.md`.

## Index

| # | Issue | Status |
|---|-------|--------|
| 1 | [Flow 4 ("pair with a teammate") is blocked on a human design review — `FL4.1`](#issue-1) | Blocked (draft exists) |
| 2 | [Automatic per-session git worktree isolation — deliberately deferred follow-ups](#issue-2) | Deferred |
| 6 | [`falcon codex` (plain terminal run) never records a `workspaceId` — breaks 4 web panels](#issue-6) | Open (codex-only; `falcon claude` fixed) |
| 11 | [Local Shift+Tab permission-mode changes only reach the web on the next tool call, and the web selector is off by default](#issue-11) | Partially fixed |
| 12 | [No model selector on the web — CLI→web model sync is one-way and only fires on a detected transcript change](#issue-12) | Landed (flag off) |
| 13 | [New Session from web: daemon-initiated spawn reproducibly fails in ~1s, with no diagnostic trail](#issue-13) | Open |
| 14 | [ACP adapter auto-install can genuinely fail/be slow — pinned adapter requires Node ≥22, this machine (and likely others) runs Node 20](#issue-14) | Open |
| 15 | [An adopted/unmanaged session's title can leak the raw Conductor `<system_instruction>` wrapper text](#issue-15) | Open |
| 16 | [Session side panel's base-branch-default fix (Phase 0.3) landed but was never live-reverified](#issue-16) | Open (needs verification) |
| 17 | [Daemon-spawned session processes survive a crashed/interrupted run and never get reaped — causes account-wide refresh-token rotation churn](#issue-17) | Open |
| 18 | [Re-pairing an already-registered machine to a different account silently leaves it owned by the original account](#issue-18) | Open |
| 19 | [A browser that connects after the daemon does can show a false "offline" state indefinitely — blocks the Git/Repo-Files panels and the new Create-workspace button](#issue-19) | Landed (needs live re-verification) |
| 20 | [`falcon daemon stop` + `daemon start` while a `falcon claude` session is still running can trigger a false "needs re-authentication" — refresh-token rotation race, not a real security event](#issue-20) | Open (not live-confirmed) |

When an issue is resolved and verified, remove its row from this table and its section below
— don't mark it "Fixed" and leave it here, per this file's own no-growing-archive convention.

<a id="issue-1"></a>

## 1. Flow 4 ("pair with a teammate") is blocked on a human design review — `FL4.1`

**Where:** `docs/plan-flows-3-4-5.md`, execution unit `FL4.1`
("session-sharing-design-review"), Phase 2.

**What's open:** Flow 4 — letting a genuinely different person view/approve your session
from their own account/device — is not implemented, and `FL4.1` (design review) is still
unchecked in `docs/plan-flows-3-4-5.md:868`. `FL4.3` (schema/authz, line 907) and `FL4.4`
(socket/web UI, line 921) are both still unchecked and explicitly annotated "BLOCKED on
FL4.1"/"BLOCKED on FL4.3."

**Update (re-verified 2026-07-28):** a draft design doc now exists at
`docs/design-session-sharing.md`, headed **"Status: DRAFT — awaiting product/design
review, not yet approved."** It's a thorough first-pass proposal (threat model, schema,
authz helper, the RPC-routing fix below, invite-flow options, revocation semantics) written
specifically to unblock `FL4.1` — but `FL4.1`'s own Definition of Done requires **human
sign-off**, not just a draft, so this doesn't move the issue's status; a design now exists,
it just isn't approved yet. Still true as of this doc's own re-audit:

- No `session_shares`-style table exists yet (`packages/server/src/db/schema.ts` has no
  such table).
- The authorization-helper mechanism doesn't exist yet — current count of
  `eq(sessions.accountId, accountId)`-style ownership checks it would need to replace is
  **19, across 9 files** (server routes: `sessionNotify.ts`, `sessionStatus.ts`, `blobs.ts`,
  `notificationSettings.ts`, `messages.ts`, `sync.ts`, `sessionArchive.ts`, `sessions.ts`,
  `sessionCas.ts`) — corrected from this entry's earlier "~15" estimate.
- `packages/server/src/app/socket/rpcHandler.ts`'s rooms are still keyed by the *caller's*
  account (`rpcRoom(accountId, target)` → `` `rpc:${accountId}:${target}` ``, used both at
  `socket.join` on the registering side and at the lookup path using the *caller's own*
  accountId) — a teammate's `perm.answer`/`message`/interrupt calls would still silently
  resolve to nothing without the fix the design doc proposes.
- `wrapDek`/`unwrapDek` (`packages/crypto/src/dek.ts`) still supports wrapping a session's
  DEK to any content public key, not just the owner's — confirmed by the landed round-trip
  test (`FL4.2`, `packages/crypto/src/__tests__/sessionSharing.test.ts`).

**Status:** open, waiting on human approval of the now-existing draft design doc. Not
something an automated workflow can produce or check off.

<a id="issue-2"></a>

## 2. Automatic per-session git worktree isolation — deliberately deferred follow-ups

**Where:** `docs/features/worktree-isolation.md` (all 6 phases landed).

**What's open:** four items the feature's own plan flagged as consciously out of scope for
this pass, not bugs:

- **Local `falcon -b <branch>` parity.** `args.ts:159-166` (`parseDefaultStart`) still
  parses `-b`/`--branch` into `FalconCommand.branch`, but `index.ts`'s `runStart`
  (lines 341-367) never reads `command.branch` at all — local-mode sessions don't create a
  worktree at all today (only remote `spawn` does, via `gitWorktree.ts`). `index.ts`'s own
  help text advertises the flag, so this is a real CLI/remote parity gap, not just an
  omission. A real fix would call `ensureBranchWorkspace` before launching the local TUI,
  the same way `spawnEngine.ts` does for a remote spawn. Re-verified 2026-07-28: still true.
- **Worktree cleanup: now manual, still not automatic.** Fixed partially by the
  new-session-from-web redesign's Phase C: `worktree.remove` (`packages/cli/src/daemon/worktreeRemove.ts`,
  wired through `machineRpc.ts` and a web action in `session-list/components/remove-worktree-dialog.tsx`)
  lets a user manually clean up a session's worktree — plain removal first, an explicit
  second confirm for `--force` if the worktree has uncommitted/untracked changes, branch
  deletion offered as a separate, off-by-default, more-destructive choice. Nothing still
  runs this automatically on session end (deliberately out of scope — what if the user wants
  to keep working in that worktree after the session ends? — a real design question, not an
  oversight) — `.worktrees/<branch>` directories still accumulate forever unless a user
  remembers to clean them up by hand.
- **`git.branches` is local-only.** The RPC lists `refs/heads` only — no remote-tracking
  branches. Fine for the MVP existing-branch picker (you can only worktree a branch that
  already exists locally on that machine anyway), but worth revisiting if a "check out a
  remote branch" flow is ever wanted.
- **Global default (`repo-root` vs `new-branch`) is now moot for the primary flow, and the
  Settings control that used to drive it is orphaned.** The new-session-from-web redesign's
  workspace-row `+` entry point (which replaced the old free-form wizard) no longer offers a
  repo-root/existing-branch choice at all — every session from there always gets a fresh
  worktree + fresh branch, unconditionally (two parallel sessions sharing a `repo-root`
  working directory was a real correctness risk, not just a preference). But
  `packages/web/src/features/settings/components/GitSection.tsx`'s "default branch mode"
  toggle (`git-defaults.ts`'s `getDefaultBranchMode`/`setDefaultBranchMode`) is still there
  and still functional as a control — it's just that nothing reads its value anymore
  (confirmed via `grep -rl getDefaultBranchMode packages/web/src` — only `GitSection.tsx`
  and its own module/test reference it). A user can still change this setting and see no
  effect anywhere. Worth a product decision: remove the now-meaningless control, or
  repurpose it for something the new flow actually reads.

**Status:** the first bullet is now partially resolved (manual cleanup exists); the other
three are scope decisions/consequences of the broader redesign, not defects in what
landed — parking them here so the next planner finds them instead of rediscovering
them from scratch.

<a id="issue-6"></a>

## 6. `falcon codex` (plain terminal run) never records a `workspaceId` — breaks 4 web panels

**Where:** `packages/cli/src/commands/startCodex.ts:155-176` (the `doBootstrapSession(...)`
call), `packages/cli/src/session/bootstrap.ts:246` (`workspaceId: params.workspaceId ?? null`),
`packages/server/src/app/routes/sessions.ts` (`CreateSessionBodySchema`, `workspaceId ?? null`
insert), `packages/cli/src/workspace/registry.ts:211` (`registerWorkspace`, the fix pattern
below already reuses).

**Fixed for `falcon claude` (commit `898baa4`, "record workspaceId on falcon claude, rebuild
session side panel").** `packages/cli/src/commands/start.ts:496-534` now has an explicit
step ("3.5. Register (or resolve) this directory as a workspace") that calls
`doRegisterWorkspace(deps.workingDirectory)` (default: real `registerWorkspace`) and threads
the resulting `workspaceId` into `doBootstrapSession(...)`'s params (failure is caught,
logged, and falls back to the old `null` behavior rather than blocking start). `start.ts`'s
own doc comment at this call site explicitly references closing this issue.

**Still open for `falcon codex`.** `packages/cli/src/commands/startCodex.ts:155-176` has no
`registerWorkspace` call anywhere in the file — its `doBootstrapSession(...)` params object
has no `workspaceId` key at all, so `bootstrap.ts:246`'s `params.workspaceId ?? null`
fallback fires every time, identical to the original bug, just narrower in scope now.
`machineId` is unaffected (both provider commands hard-fail without it).

**Blast radius (still real for codex sessions):** every web panel that gates on
`session.machineId`/`session.workspaceId` both being present shows "This session has no
machine/workspace recorded yet" — re-confirmed still gating on both fields: git-diff
(`SessionGitScreen.tsx:40`), Repo files (`SessionFilesScreen.tsx:40`), Checks
(`SessionChecksScreen.tsx:36`), and the timeline's file-open path
(`SessionTimelineScreen.tsx:250,279`).

**What a real fix needs:** apply the same register-or-resolve call in `startCodex.ts` that
`start.ts` already has for the Claude path.

**Status:** open, codex-only — the `falcon claude` half of this issue is resolved and
verified; re-scope any future work to `startCodex.ts` specifically.

<a id="issue-11"></a>

## 11. Local Shift+Tab permission-mode changes only reach the web on the next tool call, and the web selector is off by default

**Where:** `packages/cli/src/claude/pretoolPermissionBridge.ts:618` (`cachePermissionMode`),
`:614-616` (`notePermissionMode`), `:677`/`:789` (`handlePreToolUse`/`handlePermissionRequest`,
the only two callers of `cachePermissionMode`), `packages/cli/src/claude/ptyClaudeSession.ts:212-216`
(`MODE_STATUS_PATTERNS`), `:381` (`waitForModeStatus`), `packages/cli/src/commands/start.ts:1148-1192`
(`setMode` RPC handler, `raceModeConfirmation`), `:215` (`PTY_SET_MODE_ENV_VAR = "FALCON_PTY_SETMODE"`
constant), `:1149` (the CLI-side gate check, `!= "1"` → off), `packages/web/src/components/timeline/mode-switch-state.ts:19`
(`canMutateMode`), `packages/web/src/lib/config.ts:75` (`PTY_SET_MODE_ENABLED = ... === "1"`,
confirmed off by default).

**Fixed (2026-07-28):** the `setMode` RPC's own reliability. The original bug — `setMode`
verified a switch ONLY by waiting for the next hook call's `permission_mode` field
(`waitForModeEcho`), which never arrives for an idle session (no tool call in flight, the
common case for a web-initiated mode change) — was live-reproduced: switching mode from web
while idle made the real terminal switch correctly, but the web UI reported "Could not confirm
the mode switch — reverted" and showed the wrong mode. Fixed by adding a second,
hook-independent confirmation signal: `ptyClaudeSession.ts` now pattern-matches Claude Code's
own live status-bar text (`⏸ manual mode on`, `⏵⏵ accept edits on`, `⏸ plan mode on` —
live-verified against real Claude Code v2.1.220) directly out of the raw PTY output, and
`start.ts`'s `raceModeConfirmation` resolves success the instant EITHER that signal or the hook
echo confirms the target mode. A second, deeper bug surfaced during verification and was fixed
alongside it: the raw-output confirmation alone left `pretoolPermissionBridge.ts`'s
`currentPermissionMode` cache stale (since only a hook call ever updated it), so a SECOND mode
switch typed right after the first computed its Shift+Tab press count from the wrong starting
mode and landed on the wrong target — fixed by feeding the confirmed mode back into the cache
via the new `notePermissionMode`. Live-verified: three consecutive idle mode switches from web
(Default→Plan→Accept edits→Default), each correctly confirmed with no revert and terminal/web
agreement every time.

**Still open — two separate, narrower gaps:**

- **Local Shift+Tab → web display latency.** The *original* framing of this issue — a human
  typing Shift+Tab directly in the terminal (no web RPC involved at all) — still only updates
  the web's read-only mode label on the next tool call, since `cachePermissionMode` is still
  only invoked from hook input handlers, not from the new raw-output detector. Wiring the raw-
  output detector into that path too (an always-on watcher, not just a `setMode`-targeted one)
  was scoped out of the 2026-07-28 fix as a larger, separate change.
- **Read-only selector by default.** The web's mode control only becomes a real, interactive
  dropdown for a local/PTY session when `NEXT_PUBLIC_FALCON_PTY_SETMODE=1` is set
  (`canMutateMode`) — off by default, pending the still-unchecked `docs/plan-v2.md` U4.5
  `[human]` live-soak task (20 real-world switches, no TUI corruption) — the 2026-07-28 fix
  substantially de-risks that soak but doesn't substitute for it.

(Bypass-permissions not appearing in a Shift+Tab cycle is genuine Claude Code CLI behavior —
live-reconfirmed during the 2026-07-28 fix (cycling past `plan` prints "auto mode unavailable
for this model" and falls back to `default`) — unrelated to Falcon, not a bug here.)

**Status:** partially fixed — the `setMode` RPC reliability half is done and live-verified; the
local-Shift+Tab-detection-latency half and the default-off decision remain open. Re-verified
2026-07-28 against current code: both flags (`NEXT_PUBLIC_FALCON_PTY_SETMODE` web-side,
`FALCON_PTY_SETMODE` CLI-side) are still off by default, `cachePermissionMode` is still only
reachable from hook input handlers, and no code has landed since the fix commit (`d6bc2b9`)
touching any of the five referenced files — everything above still holds exactly as written.

<a id="issue-12"></a>

## 12. No model selector on the web — CLI→web model sync is one-way and only fires on a detected transcript change

**Where:** `packages/wire/src/rpc.ts:752-765` (`SetModelParamsSchema`/`SetModelResultSchema`,
`RUNNING_SESSION_MODEL_ALIASES`), `packages/cli/src/claude/ptyClaudeSession.ts:1115`
(`sendModelChange`), `packages/cli/src/commands/start.ts:226` (`PTY_SET_MODEL_ENV_VAR`
constant), `:1203` (the CLI-side gate check), `packages/web/src/components/timeline/ComposerControls.tsx:140-149`
(the "Change model" selector), `packages/web/src/components/timeline/model-switch-state.ts:14-18`
(`canMutateModel`), `packages/web/src/lib/config.ts:90` (`PTY_SET_MODEL_ENABLED = ... === "1"`,
confirmed off by default).

**What shipped:** a real `setModel` session RPC, mirroring `setMode`'s PTY-injection design —
the CLI types `/model <alias>` into the live PTY through the same `InjectionController` gate
chat messages use, verifies the switch via the transcript's own "Set model to ..." echo, and
auto-confirms Claude Code's own "Switch model?" dialog (detected from raw PTY output, since
Claude Code renders that dialog live and never writes it to the JSONL transcript) when one
appears for a session with existing conversation history. `model` is a closed enum
(`RUNNING_SESSION_MODEL_ALIASES`: `sonnet`/`opus`/`haiku`/`sonnet[1m]`/`opus[1m]`), not a free
string — the value is typed as raw keystrokes into a live terminal, so an arbitrary string
would be a keystroke-injection vector. The web composer footer now has a real "Change model"
dropdown, and the model chip falls back to "Model unknown" instead of silently disappearing
when `metadata.model` is unset. Codex (`startCodex.ts`) has no PTY to inject into and reports
`{ok:false}` honestly rather than pretending support.

Verified live end-to-end against a real `falcon claude` PTY session running the actual Claude
Code CLI (server → RPC → PTY keystrokes → transcript detection → metadata persisted → web chip
updates), including one confirmed live occurrence of the "Switch model?" dialog. The
auto-confirm fix for that dialog is covered by unit tests against the exact captured dialog
text but was **not** independently re-triggered live a second time to visually confirm in the
browser — Claude Code's own trigger condition for the dialog wasn't fully pinned down (several
same-shape repro attempts afterward didn't reproduce it), so treat that specific path as
unit-tested, not live-reverified.

**What's still open:** same rollout question issue #11 already raises for `setMode` — the web
selector only appears once `NEXT_PUBLIC_FALCON_PTY_SETMODEL=1` is set on the web build *and*
`FALCON_PTY_SETMODEL=1` is set on the CLI process (defaults off, off by default until
live-soaked, same double-flag-gating precedent `setMode` uses). A decision on when/whether to
flip that default on is still open.

**Deep-dived 2026-07-28 (prompted by "hasn't this already shipped, can the gate come off?")
— verdict: no, and the gap is worse than "just needs a soak."** Unlike `setMode`, which has
an explicit, still-unchecked `[human]` live-soak task (`docs/plan-v2.md` U4.5, "20 real-world
switches, no TUI corruption"), `setModel` was never run through that unit pipeline at all —
it landed directly via commit `40620ac`, with exactly one live-verification event on record
(that commit's own message). Re-reading the actual current implementation surfaced concrete,
demonstrable correctness bugs, not just "unverified":

- **False-positive on a switch Claude Code itself refused.** Claude Code appends
  `" [blocked]"` when it declines a `/model` change (e.g. unavailable for the account tier).
  `packages/cli/src/claude/modelChange.ts`'s parser strips that marker and returns the model
  name identically either way — confirmed by a *passing* test
  (`modelChange.test.ts:72-85`) that captures exactly this case without flagging it. Since
  `start.ts`'s `waitForModelEcho` consumes the same parser, a refused switch is reported to
  web as `{ok:true}`.
- **No requested-vs-observed equality check.** `setMode`'s handler checks
  `observed === mode` before confirming; `setModel`'s `waitForModelEcho`
  (`start.ts:742-760`) accepts *whatever* "Set model to ..." echo appears next within the 8s
  window, even from an unrelated event. No test exercises a mismatch — the two existing
  tests (`start.test.ts:1392,1404`) both request and observe the same model.
- **The "Switch model?" dialog isn't covered by the general open-prompt gate.**
  `armModelSwitchConfirmWatcher` (`ptyClaudeSession.ts:696-703`) never calls
  `controller.setPromptOpen(true)`, so once the injection controller's ~1200ms post-submit
  cooldown expires, a second queued injection (another chat message, a mode switch) could
  land keystrokes into the still-open dialog instead of/alongside the intended "1"+Enter.
  Not exercised by any test.
- **Silent stuck-dialog failure mode.** If Claude Code ever changes the dialog's wording,
  the 5s watcher (`MODEL_SWITCH_CONFIRM_ARM_MS`) just disarms with no signal to the caller —
  the real terminal is left with an open, unanswered dialog and nothing re-arms or notifies
  anyone.
- The e2e/integration harness's `setModel` (`e2e/src/fakeSessionProcess.ts:177-180`) is an
  unconditional `{ok:true}` stub with an explicit comment that it has no scripted scenario —
  it doesn't exercise the real PTY-dialog logic at all, so CI gives no signal on any of the
  above.

The comparison that matters: `setMode` — the sibling everyone already agrees needs its human
soak — has *stronger* verification (dual signal + equality check) and is *more reversible*
(Shift+Tab again vs. a one-shot confirm with no recovery path), and it just received a live
E2E bug-fix pass today (`d6bc2b9`) that found and fixed a real reliability issue. `setModel`
has had zero follow-up passes since its original landing. If the more-defended, more-
reversible sibling still needed that pass, this one needs it more, not less.

**Status:** landed behind a flag, not ready to flip — re-scoped 2026-07-28 from "just needs a
soak" to "has specific, fixable correctness bugs (false-positive on blocked switches, no
observed-model equality check, unguarded confirm-dialog race) that should be fixed before any
soak is even worth running." Both flags confirmed still off by default.

<a id="issue-13"></a>

## 13. New Session from web: daemon-initiated spawn reproducibly fails in ~1s, with no diagnostic trail

**Where:** `packages/cli/src/daemon/spawnEngine.ts` (`spawnSession`, the `spawn` RPC handler),
`packages/cli/src/daemon/processLauncher.ts` (`trySpawnViaTmux`, `watchPidByPolling`),
`packages/cli/src/daemon/spawnAwaiter.ts` (`waitFor`'s exit-watcher fast-rejection, landed as
part of the new-session-from-web redesign's Phase A). Found via live manual QA (real dev
stack, real paired machine, real web UI) — not caught by any test in the repo.

**What's open:** clicking a workspace row's `+` and submitting "Start session" against a real
paired machine reproducibly fails after ~1 second, every time (3/3 attempts). The web UI
correctly shows the honest, translated error this session's own Phase B4 work added —
*"The session process exited before it could start. Check that machine's `falcon` logs for
what went wrong"* — which is a real improvement over the old generic 15s-timeout message, but
following that instruction leads nowhere: the daemon's own log only records the fact of the
fast exit, not why:

```
[spawn-engine] launched provider process {"method":"tmux","pid":44961,"directory":".../worktrees/wf/20260728-bb09"}
[machine-rpc] handler threw {"method":"spawn","error":"spawn launched (pid 44961, tmux) but spawned process (pid 44961) exited before it reported starting"}
```

Confirmed via direct investigation:

- The worktree/branch creation itself succeeds correctly — the target directory exists on
  disk with the right content every time, ruling out `gitWorktree.ts` as the cause.
- Session-lock collision was ruled out directly: `sessionLock.ts`'s lock key includes the
  exact `workingDirectory` (`start.ts:483,538`), which differs between the worktree and any
  other concurrently-running session in the same repo — confirmed via code read, not just
  assumption.
- The daemon process's own environment was directly inspected (`ps eww <daemon-pid>`) and
  correctly has `FALCON_HOME_DIR`/`FALCON_BACKEND_URL`/`FALCON_FRONTEND_URL` set, ruling out
  an obvious env-inheritance gap for the daemon itself.
- **Root cause not fully isolated, because tmux itself makes this undebuggable in
  production today.** `processLauncher.ts`'s `trySpawnViaTmux` never sets
  `remain-on-exit`, so the instant the spawned command process exits, tmux destroys the
  session/pane along with any stdout/stderr it produced — there is no way, in the current
  code, to recover *why* a tmux-spawned remote session died fast, whether from a real daemon
  spawn or from manual reproduction of the identical `tmux new-session` invocation.
- A **manual, non-tmux** reproduction of the exact same `falcon claude --starting-mode remote
  --started-by daemon` invocation (run directly, cwd'd into the same worktree) got further —
  it reached the ACP adapter connection/auto-install stage before eventually failing there
  (see issue #14) — meaning the tmux path is failing at some EARLIER step than the non-tmux
  path does, for a reason specific to how the daemon actually launches it.

**What a real fix needs:** (1) add `remain-on-exit on` (or an equivalent output-capture
mechanism, e.g. redirecting the tmux pane's command to a log file before it runs) to
`trySpawnViaTmux` so a fast-failing tmux-spawned session leaves a diagnostic trail instead of
vanishing — this is required groundwork before the actual root cause of the ~1s failure can
even be identified with confidence; (2) once real output is captured, root-cause and fix the
actual ~1s failure itself — this issue only captures the confirmed symptom, not yet the
underlying cause.

**Update (re-reproduced 2026-07-30):** hit again via the new "Create new workspace" flow
(`docs/web-ux-improvements-plan.md`'s feature 4) — spawning a session into a freshly-created,
never-before-used empty folder failed with the identical error shape, `"exited before it
reported starting"`. Same symptom as the original repro above (an existing worktree branch),
just against a brand-new empty directory instead — rules out "something specific to worktree
branches" as the cause, narrowing it toward the daemon's generic tmux-spawn path itself. Still
not root-caused; the `remain-on-exit`/diagnostic-trail fix above is still the needed first step.

**Status:** open, not started — newly found via live end-to-end testing 2026-07-28, not
caught by any existing test (the daemon-spawn unit tests mock the child process entirely; the
one e2e harness fakes away the same thing). This is the core "New Session from web" flow the
whole redesign exists for — treat as highest priority among currently-open issues.

<a id="issue-14"></a>

## 14. ACP adapter auto-install can genuinely fail/be slow — pinned adapter requires Node ≥22, this machine (and likely others) runs Node 20

**Where:** `packages/cli/src/adapters/manifest.ts` (`ADAPTER_MANIFEST`, the pinned
`@agentclientprotocol/claude-agent-acp@0.59.0` version), `packages/cli/src/adapters/install.ts`
(`installAdapter`, the underlying `npm install` call), `packages/cli/src/acp/acpConnection.ts`
(`connect()`'s auto-install trigger, landed this session for known-issues #13's original
scope). Found via live manual QA.

**What's open:** the new-session-from-web redesign's auto-install fix (`AcpConnection.connect()`
now auto-installs a missing adapter instead of just failing) was confirmed live to actually
trigger correctly:

```
[acp-connection] adapter "claude-code" is not installed — auto-installing before spawn
...
[acp-remote] failed to start ACP session {"error":"ACP adapter \"claude-code\" is not installed and auto-install failed: Command failed: npm install @agentclientprotocol/claude-agent-acp@0.59.0 --save-exact --omit=dev --no-audit --no-fund\n"}
```

Reproducing the same `npm install` command standalone on this machine confirms why it's
fragile: the pinned package declares `"engines": {"node": ">=22"}`, but this machine's active
Node is v20.15.1 — `npm warn EBADENGINE` — and the install still took **37 seconds** to
resolve/complete even though it eventually succeeded when given enough time and run outside
whatever budget the daemon's own attempt was working within. Node 20 is not an exotic,
misconfigured setup — LTS Node 20 is a very plausible version for a real user's machine to
still be on. This is a **real**, live-confirmed failure mode of the fix landed this session,
not a hypothetical.

**What a real fix needs:** (1) at minimum, detect an `EBADENGINE`-class failure specifically
and surface an honest, actionable message ("this machine's Node version (20.x) is too old for
the Claude Code adapter — upgrade to Node 22+") instead of the current opaque "Command failed:
npm install ..." string, which is exactly the kind of raw, untranslated error this session's
own Phase B4 work was built to eliminate elsewhere; (2) consider whether `install.ts` should
proactively check the running Node version against the manifest's engine requirement *before*
attempting the install, so this fails fast with a clear message rather than waiting out a slow
`npm install` first; (3) separately, confirm what timeout (if any) bounds the auto-install
attempt inside a daemon-initiated spawn — if it's tighter than the ~37s a real install can
take under normal conditions, a *correctly configured* machine with adequate Node could still
time out through no fault of its own.

**Status:** open, not started — newly found via live end-to-end testing 2026-07-28. Likely a
meaningful contributor to issue #13's fast-failure symptom on machines where the tmux path
gets far enough to reach this step (not yet confirmed whether it's the SAME failure as #13's
~1s crash, which happens too fast to be this — see #13's own notes on the two reproductions
diverging).

<a id="issue-15"></a>

## 15. An adopted/unmanaged session's title can leak the raw Conductor `<system_instruction>` wrapper text

**Where:** `packages/cli/src/daemon/transcriptIndexer.ts:206-217` (`parseTranscript`'s title
preference: Claude Code's own `{"type":"summary"}` entry if one exists, else `firstUserText` —
the raw text of the FIRST `type: "user"` transcript entry, truncated via `truncateTitle`, no
other filtering), consumed by `packages/cli/src/adopt/listSessions.ts:65` and surfaced to the
web's "Unmanaged sessions" list on Home.

**What's open:** when a session is started inside an environment (Conductor, or any other
wrapper) that injects its own instructional preamble as the transcript's first `user` message
— e.g. a literal `<system_instruction> You are working inside Conductor, a Mac app that
lets...` block — and Claude Code hasn't yet generated its own `{"type":"summary"}` entry for
that session (a short/new session, the common case for something still showing up as
"unmanaged"), `firstUserText` falls back to that raw injected block verbatim. Observed live on
Home's "Unmanaged sessions" list during session-panel-workflow-plan.md's E2E test pass
(2026-07-29): several entries showed `<system_instruction> You are working inside Conductor, a
Mac app that lets...` as their displayed title instead of anything resembling the actual task.

**What a real fix needs:** `parseTranscript`'s `firstUserText` fallback should recognize and
skip a leading `<system_instruction>...</system_instruction>` (or similarly-wrapped
environment-preamble) block when picking the first *genuine* human-authored line, rather than
treating the transcript's first `user`-role entry as automatically representative — the same
"don't trust the first line blindly" problem multi-agent harnesses in general run into.

**Status:** open, not started — found via live E2E testing, not yet fixed. Purely cosmetic (a
confusing/ugly title, not a data-integrity or security issue), but worth fixing since it's the
first thing a user sees for exactly the sessions they're least sure about (unmanaged/adopted
ones).

<a id="issue-16"></a>

## 16. Session side panel's base-branch-default fix (Phase 0.3) landed but was never live-reverified

**Where:** `packages/web/src/features/session-list/components/new-session-panel.tsx` (the
`useEffect` re-running `actions.listBranches`/`actions.getConfig` on `actions` identity change,
added alongside issue #17's neighboring race-condition fix), `packages/web/src/features/session-list/inline-spawn.ts`'s
`deriveDefaultBaseBranch` (prefers a configured `baseRef` over the current-checked-out branch).

**What's open:** an earlier E2E pass found the `+` spawn panel's base-branch picker ignoring a
workspace's configured `baseRef` (`falcon workspace config --base-ref main`) and always
falling back to the current-checked-out branch instead — isolated with a differentiating test
(checked out a throwaway branch, confirmed the picker followed it, not the configured `main`).
The most likely cause was the same "`actions` starts as a permanently-rejecting stub until this
machine's crypto key unwraps, and nothing ever retried once it did" bug documented for
`git.status`/`fs.list`/`github.checks` (session-panel-workflow-plan.md's Phase-1 fix) —
`workspace.getConfig` is a machine RPC gated the same way, and `new-session-panel.tsx`'s
prefetch effect got the same fix (a second effect keyed on `actions`, re-running the
`listBranches`/`getConfig` prefetch the moment the stub is swapped for the real client). That
fix was verified live for the Changes/Checks/All Files tabs (2026-07-29) but the base-branch
picker specifically was never re-opened and re-checked afterward.

**What a real fix needs:** open a workspace's `+` spawn panel against a workspace with a
configured `baseRef` that differs from its current-checked-out branch, and confirm the "From"
field actually defaults to the configured ref. If it still doesn't, this is a distinct bug from
the one already fixed, not just an unverified case of it.

**Status:** open pending verification — likely already fixed as a side effect of a neighboring
change, but nobody has confirmed it live yet. Don't assume it's resolved.

<a id="issue-17"></a>

## 17. Daemon-spawned session processes survive a crashed/interrupted run and never get reaped — causes account-wide refresh-token rotation churn

**Where:** `packages/cli/src/daemon/sessionRegistry.ts` (re-adopts a still-live orphaned
process's pid on daemon restart — confirmed via daemon log lines
`"[session-registry] re-adopted live orphaned session after restart"` — rather than
terminating it), whatever issues/refreshes the machine/session refresh token (daemon log
lines: `"[token-provider] refresh token rejected but a newer one is on disk (likely rotated by
a sibling process) — retrying once"`). Exact token-rotation code path not traced line-by-line;
this entry documents the confirmed symptom and repro, not the internals.

**What's open:** during session-panel-workflow-plan.md's E2E test pass (2026-07-29), an
interrupted/restarted test-agent run repeatedly left the previous run's `falcon claude`
processes (and their ACP adapter subprocesses) alive rather than terminated. On daemon
restart, `sessionRegistry.ts` re-adopts these as live tracked sessions instead of reaping them.
With several such orphaned processes accumulating under one account, the daemon log showed
constant `[session-client]`/`[machine-client]` disconnect→reconnect churn every ~20-90
seconds, each cycle logging a `"refresh token rejected but a newer one is on disk (likely
rotated by a sibling process) — retrying once"` warning — multiple live processes racing to
refresh the same account's token, each rotation invalidating the token another sibling process
was mid-flight on. Confirmed via direct process inspection (`ps`, matching each process's `cwd`
against directories that had already been removed) that several of the accumulated processes
were genuine zombies with no reachable working directory at all. Killing the orphaned
processes stopped the churn immediately and completely (confirmed via clean logs afterward).

This was reproduced via *this session's own* repeated interrupted test runs, not a single
crash — but a daemon restart after ANY ungraceful process death (a machine sleep/crash, a
`kill -9`, a power loss) would leave the same kind of orphan behind, and this account only had
a handful of them; a real user's machine restarting after a crash with several sessions running
could plausibly hit the same churn.

**What a real fix needs:** on daemon restart, distinguish "orphaned process I should keep
tracking because the user might still want it" from "orphaned process that's actually dead
weight" more actively than pid liveness alone — e.g. a staleness check, or a bounded number of
concurrent refresh-token holders, or making the rotation itself tolerant of multiple
legitimately-live siblings without each retry cycle producing visible churn. At minimum, some
operator-facing way to see "N orphaned sessions from a previous run are still live" and clean
them up, rather than relying on `ps`-and-`kill` by hand.

**Status:** open, not started — found via live E2E testing, workaround (manually kill the
orphaned processes) confirmed effective but not a fix.

<a id="issue-18"></a>

## 18. Re-pairing an already-registered machine to a different account silently leaves it owned by the original account

**Where:** `packages/server/src/app/routes/machines.ts` — the `if (machineId)` branch's lookup
(`where: and(eq(machines.id, machineId), eq(machines.accountId, accountId))`, ~line 133/192)
scopes an existing-machine registration to the CALLER's own `accountId`; the `!machineId`
branch (line 79-113) is the only path that inserts a fresh row under a new `accountId`. Root
cause not fully isolated — see below.

**What's open:** ran `falcon auth login` a second time against a daemon whose
`daemon.state.json` already carried a `machineId` from an earlier pairing to Account A, while
approving from a browser signed into a different Account B. The CLI reported `"auth login:
succeeded"`, the browser's approval screen showed "Connected," and the daemon's own
`machine-client` connected without error — every visible signal said success. But
`machines.account_id` in Postgres still pointed at Account A (confirmed via direct query), and
Account B's synced snapshot (`/v1/sync`) reported zero machines — silently; nothing in the CLI,
the daemon logs, or the web UI surfaced any mismatch. The practical effect: every machine-RPC
action in Account B's web UI (git status, files, checks — the whole session side panel) was
stuck indefinitely on "machine key isn't unwrapped yet," because the account genuinely has no
machine to unwrap a key for, and there was no error message pointing at why.

Given `machines.ts`'s own `if (machineId)` lookup is scoped to `eq(machines.accountId,
accountId)`, the most likely mechanism: whatever daemon-side call re-registers/reconnects an
existing `machineId` after a successful pairing handshake sent the OLD `machineId` under the
NEW account's auth context, that lookup found nothing (machine belongs to a different
account), and whatever happened next (a 404? a silent no-op?) wasn't surfaced anywhere a user
would see it. Not confirmed by tracing that exact call site — flagging the mechanism as the
most likely one, not a verified root cause.

**What a real fix needs:** (1) root-cause which call actually re-registers the machine after
`falcon auth login` succeeds, and what it does when the existing `machineId` doesn't belong to
the authenticating account; (2) either make cross-account re-pairing of an existing machine
identity work (transfer ownership, with whatever confirmation that deserves) or make it fail
loudly (`auth login` itself should error, not report success) — the current silent-mismatch
outcome is the worst of both; (3) the web side has its own gap worth fixing independently: an
account with zero machines but a session that references a `machineId` shows the same generic
"machine key isn't unwrapped yet — try again in a moment" as an ordinary transient race,
indefinitely, with no way to tell the two apart.

**Status:** open, not started. A fairly obscure trigger (re-pairing one daemon across two
different accounts isn't a normal user flow), found by accident while re-establishing test
infrastructure, not while testing this specific path on purpose — but the silent-failure shape
(everything reports success, the actual state is just wrong) is the kind of thing worth fixing
regardless of how rare the trigger is.

<a id="issue-19"></a>

## 19. A browser that connects after the daemon does can show a false "offline" state indefinitely — blocks the Git/Repo-Files panels and the new Create-workspace button

**Where:** `packages/web/src/features/session-list/use-machine-presence.ts:68-84`
(`MACHINE_ONLINE_WINDOW_MS = 3 * 60_000`, `isMachineOnlineHeuristic`, `deriveMachineOnline`/
`deriveMachineStatus` — falls back to this heuristic whenever no live presence event exists yet
for the machine), `packages/web/src/lib/use-sync-snapshot.ts:46` (`staleTime:
Number.POSITIVE_INFINITY` on the `['sync']` query), `packages/web/src/sync/engine.ts:124-227`
(the only two places the `['sync']` cache is ever refreshed: a header-seq gap or a full WS
reconnect — never a timer), `packages/web/src/lib/use-machine-online.ts:31-37`
(`useMachineOnline`'s own doc comment already names the mechanism: "`machine-presence` is only
emitted on a machine socket's own connect/disconnect — there is no periodic sweep and no
retroactive snapshot for a web client that connects later"), `packages/web/src/features/
session-list/components/new-workspace-panel.tsx:107-109` (`canCreate` requires
`!machine.isKnownUnavailable`, so this bug also disables the new-workspace Create button).

**What's open:** found via live E2E testing (2026-07-30) of the new-workspace-creation and
daemon-offline-gating features. Two mechanisms combine into a real, reproducible false-offline
state, not a one-off flake:

1. The live `machine-presence` ephemeral fires only at the instant a machine's daemon socket
   connects or disconnects. A browser tab already open when the daemon connects — or one that
   connects to the server after the daemon already has — never receives that event, and so has
   no entry in its local presence map for that machine at all, until the daemon's socket
   disconnects and reconnects again.
2. Without a live presence entry, `deriveMachineStatus` falls back to `machine.lastSeenAt` from
   the `['sync']` snapshot, requiring it to be within `MACHINE_ONLINE_WINDOW_MS` (3 minutes) of
   "now." But that `['sync']` query is fetched with `staleTime: Number.POSITIVE_INFINITY` and is
   only ever refreshed by `sync/engine.ts` on a header-seq gap or a full WS reconnect — never on
   a timer. A machine's own periodic `lastSeenAt` write-behind is server-side only and does not
   appear to bump `accounts.headerSeq` or push a `machine-update`, so the client's cached
   `lastSeenAt` simply stops advancing once the snapshot is first fetched.

Net effect: once more than 3 minutes pass since a browser's last `['sync']` fetch, with no live
presence event ever having arrived for that machine, a genuinely healthy, fully-connected
machine reads as `"offline"` client-side. Confirmed live: the daemon and server both showed a
healthy connection throughout, but the web UI's Git panel showed "Could not load git status." /
"No files found." and the new-workspace flow's Create button stayed disabled via `canCreate`'s
`!machine.isKnownUnavailable` check — both symptoms cleared the moment something else happened
to trigger a `['sync']` resync (e.g. reloading the page).

**What a real fix needs:** (1) the simplest fix is likely a bounded periodic refetch of the
`['sync']` snapshot (or at minimum re-deriving `isKnownUnavailable` against wall-clock time on
an interval, not just on cache updates), so a stale-but-still-accurate `lastSeenAt` can't
silently outlive the 3-minute window; (2) more directly, consider having the server proactively
push a `machine-update` (or a fresh presence ephemeral) to a newly-connecting `user`-scoped
socket for every machine that's currently connected, rather than only at the instant of the
machine's own connect/disconnect — closing the "browser connects after daemon" gap at the
source instead of working around it client-side.

**Status:** open, not started — newly found via live E2E testing 2026-07-30, root cause
confirmed via direct code read (not just the observed symptom): the `staleTime: Infinity` +
connect/disconnect-only presence model has no path to ever refresh a stale-but-online machine's
status without an unrelated structural event happening to trigger a resync first.

**Update (2026-07-30):** fixed. `packages/server/src/app/socket.ts`'s machine-scoped
`machine-alive` heartbeat handler now re-emits the `machine-presence` ephemeral on every
heartbeat (not just at connect), closing gap 2 for a browser that was already connected when
the daemon came online; a new initial-snapshot block in the same connection handler queries
`EventRouter.isMachineOnline` (`packages/server/src/app/events/eventRouter.ts`) for every
machine on the account and emits a one-time `machine-presence` snapshot to a freshly-connecting
`user-scoped` web socket, closing gap 1 for a browser that connects after the daemon already
has. Both covered by new integration tests in `packages/server/src/app/socket.test.ts`
("re-broadcasts machine-presence online on every machine-alive heartbeat, not just connect",
"sends an initial machine-presence snapshot to a freshly-connected web client..."). Not yet
live-reverified end-to-end in a real browser — remove this issue once someone confirms the
original repro (reload the web UI against an already-online machine, confirm no false
"offline") no longer reproduces.

<a id="issue-20"></a>

## 20. `falcon daemon stop` + `daemon start` while a `falcon claude` session is still running can trigger a false "needs re-authentication" — refresh-token rotation race, not a real security event

**Where:** `packages/cli/src/auth/tokenProvider.ts:32-44` (the `readCurrentRefreshToken` doc
comment already names the exact hazard: "this refresh token may already be one rotation behind
another long-lived process sharing the same home dir (the daemon's own `TokenProvider` vs. a
`falcon claude` session's)"), `:82-98` (`doRefresh`'s one-shot stale-by-one retry, which only
covers a 401 discovered on the FIRST attempt), `packages/server/src/app/routes/refresh.ts:66-96`
(the previous-hash replay/theft-detection branch — `GRACE_MS = 60_000`; outside that window it
revokes the entire `familyId`, not just the one stale token), `packages/server/src/app/
machineReauth.ts` (`computeMachineNeedsReauth`, the sole consumer of `revokedAt` that produces
the "needs re-authentication" status), `packages/server/src/app/socket.ts` (machine-scoped
disconnect handler calling `computeMachineNeedsReauth`, and the `/v1/sync` bootstrap path via
`computeMachinesNeedReauth`).

**What's open:** `falcon claude` runs two long-lived sibling processes against the same
account — the background daemon (`machineClient.ts`'s own `TokenProvider`) and the foreground
interactive session (`sessionClient.ts`'s own, separate `TokenProvider`) — both reading/writing
the SAME single-use rotating refresh token file (`~/.falcon/access.key`). Running
`falcon daemon stop` then `falcon daemon start` while the foreground session keeps running spins
up a brand-new daemon process with a brand-new, empty-cache `TokenProvider`, so its very first
`getAccessToken()` call hits `/v1/auth/refresh` immediately. If the still-running session
process's own refresh timer rotates the shared token at a moment that races the new daemon's own
refresh attempt, one of the two presents an already-rotated (stale) hash to the server. The
client-side one-retry mitigation only helps when the FIRST attempt gets a clean 401; it does
nothing to stop the server's own replay/theft check (`refresh.ts`'s branch (2)) from firing if
the stale presentation lands outside the 60-second grace window — and when it does, the server
revokes the whole token family, which `computeMachineNeedsReauth` then reports as
`needsReauth: true`, surfacing "This project's machine needs to sign in again. Run
`falcon auth login` there." on the web even though nothing was actually compromised and the user
did nothing but restart the daemon.

**Not live-reproduced in this pass.** This is a code-read-derived root cause from a 2026-07-30
conversation (traced `tokenProvider.ts`'s own hazard comment through `refresh.ts`'s
replay-detection branch to `machineReauth.ts`'s consumer), not yet confirmed via captured
logs/DB state from an actual repro. Closely related to issue #17 (same shared single-use
rotating token, same warning log line — `"refresh token rejected but a newer one is on disk
(likely rotated by a sibling process) — retrying once"`) but a distinct and more severe
consequence: issue #17's churn is a retry-and-recover loop caused by ACCUMULATED zombie
processes; this is a full account lockout (forced re-login) from an entirely ordinary
two-process setup (one daemon, one live session, no zombies required).

**What a real fix needs:** the underlying design gap is the same one issue #17 already flags —
multiple legitimate sibling processes sharing one single-use rotating credential with no
coordination between them. Real options: (1) give sibling processes on the same machine a way to
coordinate refreshes (e.g. a file lock around rotation, or one process designated the sole
refresher with others reading its result), so concurrent rotation never happens at all; (2)
widen the server's grace window specifically for same-family concurrent rotation, since a
same-device race is categorically different from a cross-device replay and shouldn't be judged
by the same 60s theft heuristic; (3) at minimum, don't let a benign same-device race escalate to
full-family revocation — a softer "this looks like our own sibling, not theft" response would
avoid demanding re-login for something the user did nothing wrong to cause.

**Status:** open, not started — found via a code-reading deep-dive prompted by a user-reported
symptom (2026-07-30: "I run `falcon daemon stop` then `start` again and the web UI shows
'needs re-authentication'"), not yet independently live-reproduced or confirmed via logs. Needs
an actual repro (stop/start the daemon while a session stays live, capture server logs and the
`device_sessions.revoked_at`/`family_id` state) before this can move past "likely mechanism."

