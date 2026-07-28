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
| 15 | [A workspace's `+` spawn registers the new worktree as its own separate top-level workspace, not nested under the parent](#issue-15) | Open (needs product decision) |

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

## 15. A workspace's `+` spawn registers the new worktree as its own separate top-level workspace, not nested under the parent

**Where:** `packages/cli/src/workspace/registry.ts` (`registerWorkspace`, called by
`start.ts`/`startCodex.ts` against `process.cwd()` with no ancestor-directory resolution —
already documented as a deliberate design choice elsewhere in this codebase),
`packages/web/src/features/session-list/group.ts` (`WorkspaceGroup`, groups purely by
`workspaceId`, which is one-per-registered-directory). Found via live manual QA.

**What's open:** clicking "project-a"'s `+` and starting a session created a new worktree at
`project-a/.worktrees/wf/20260728-bb09` — but on the Home screen, that session did not appear
nested under the "project-a" workspace group the user clicked `+` from. It appeared as a
**separate, top-level workspace group** named "20260728-bb09" (the worktree directory's own
basename), sitting alongside "project-a" rather than under it. This is a direct, mechanical
consequence of two already-existing, individually-reasonable design choices — each worktree
gets registered as its own workspace (no ancestor-directory resolution), and the Home screen
groups purely by `workspaceId` — but the *combined* effect at the exact moment this session's
redesign asks a user to click `+` on a specific, named workspace is a visibly surprising one:
the thing you clicked "+" on is not where the result shows up.

**What a real fix needs:** a product decision, not obviously a bug fix. Options worth
considering: (a) have the Home screen group by the worktree's *parent* repo/workspace instead
of by the exact registered `workspaceId` when the two differ only by a `.worktrees/<branch>`
suffix (a client-side display grouping change, no server/schema change needed); (b) don't
register a worktree as its own independent workspace entry at all, and instead associate its
sessions with the parent workspace's existing `workspaceId` directly; (c) accept the current
behavior as correct/intentional (parallel worktrees really are semi-independent working
directories) and instead make the `+` flow's own post-submit UX clearer about where the new
session will land, so it's not a surprise.

**Status:** open, not started — newly found via live end-to-end testing 2026-07-28. Not
blocking (the session is fully functional and reachable, just grouped differently than a user
would expect), but worth resolving since it directly affects the discoverability the `+`-per-
workspace redesign was meant to improve.

