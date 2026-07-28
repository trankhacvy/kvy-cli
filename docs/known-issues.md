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
| 13 | [ACP adapter binaries are never auto-installed — remote/web-spawned sessions can silently fail or hang](#issue-13) | Open |

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
- **No worktree cleanup lifecycle.** Nothing ever runs `git worktree remove` or deletes the
  branch once a session ends — `.worktrees/<branch>` directories (and their branches)
  accumulate forever. The new `.git/info/exclude` entry (Phase 3) only hides them from
  `git status`; it doesn't reclaim disk. This ties to the separate "session lifecycle
  actions" competitive item and should land before the global default (below) flips.
- **`git.branches` is local-only.** The RPC lists `refs/heads` only — no remote-tracking
  branches. Fine for the MVP existing-branch picker (you can only worktree a branch that
  already exists locally on that machine anyway), but worth revisiting if a "check out a
  remote branch" flow is ever wanted.
- **Global default stays `repo-root`.** Settings → Git ships with "Repo root" as the shipped
  default (no silent behavior change), diverging from Omnara's worktree-by-default framing.
  Revisit flipping `git-defaults.ts`'s fallback to `"new-branch"` once the cleanup lifecycle
  above exists — recommending "New worktree" daily without any cleanup story would be a
  worse default, not a better one.

**Status:** all four are scope decisions the feature's plan doc made explicitly, not defects
in what landed — parking them here so the next planner finds them instead of rediscovering
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

## 13. ACP adapter binaries are never auto-installed — remote/web-spawned sessions can silently fail or hang

**Where:** `packages/cli/src/adapters/manifest.ts`, `install.ts:94,160`, `verify.ts:55-93`,
`spawn.ts:29-37` (the adapter manager); `packages/cli/src/acp/acpConnection.ts:282-311`
(`connect()`, throws `AcpConnectionError` with no auto-install fallback if verification
fails); `packages/cli/src/commands/adapters.ts:16,40` (the only caller of the installer —
`falcon adapters install|upgrade`); `packages/cli/src/daemon/spawnEngine.ts:320`
(`awaiter.waitFor(launched.pid)`, the `spawn` RPC handler); `packages/cli/src/daemon/spawnAwaiter.ts:40`
(`DEFAULT_SPAWN_AWAITER_TIMEOUT_MS = 15_000`); `packages/cli/src/commands/start.ts:562`
(`doNotifyDaemonSessionStarted(...)`, Claude-only — corrected from this entry's earlier
`:587`); `packages/cli/src/commands/startCodex.ts:123-127` (hard-exits before bootstrap if
the real `codex` CLI isn't on PATH; never calls `notifyDaemonSessionStarted` under any
circumstance — see strengthened claim below).

**What's open:** each supported agent (`claude-code`, `codex`) is a separate npm package
(`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`), installed
into `~/.falcon/adapters/` via a pinned-version, integrity-checked `npm install` — but
that install is **only ever triggered manually**, by a user running
`falcon adapters install`/`upgrade`. Nothing calls it automatically: no `postinstall` hook
on the `falcon` package itself, and no lazy-install on first use — `AcpConnection.connect()`
just throws `AcpConnectionError` if the adapter isn't already verified-installed.
`install.ts`'s own doc comment states explicitly: "No daemon interaction... not something
the daemon mediates" — confirmed by grep, daemon startup code never calls the installer.

That's a tolerable UX for a local terminal user (they see the error, run the install
command themselves). It breaks down for sessions spawned from the web, where nobody is
watching that machine's terminal:

- **Claude:** the daemon's `spawn` RPC reports "session started"
  (`notifyDaemonSessionStarted`, `start.ts:562`) right after bootstrap, *before* the adapter
  is ever touched — the ACP connection is only opened later, inside `runRemoteLoop()`
  (`start.ts:1290+` → `acpRemote.ts:191`). The web UI shows a session that looks live, then
  the failure surfaces later as a confusing in-transcript message ("Remote session failed to
  start: ACP adapter ... not-installed") — no proactive install offered, no upfront error.
- **Codex is worse than originally scoped here — re-verified 2026-07-28.** A repo-wide
  search confirms `commands/startCodex.ts` never calls `notifyDaemonSessionStarted` under
  **any** circumstance, not just when a dependency happens to be missing — the `/session-started`
  callback is only ever issued from the `falcon claude` path. That means a daemon-initiated
  Codex spawn (`spawnEngine.ts:320`'s `awaiter.waitFor`) will **always** hit
  `spawnAwaiter.ts`'s bounded 15-second timeout and reject with a `SpawnError`, regardless of
  whether `codex`/the adapter are even installed correctly — Codex web-spawn cannot
  currently succeed at all via this path, dependency status aside. (It's a bounded ~15s
  timeout ending in a clear `SpawnError`, not a literal infinite hang — worth being precise
  about that.) `startCodex.ts:123-127` separately hard-exits before bootstrap if the real
  `codex` CLI binary isn't on PATH — a second dependency Falcon can't fix by installing its
  own package. `docs/plan.md:1182` still shows Codex web-spawn E2E as an unchecked item,
  consistent with this.

**What a real fix needs:** (1) have the daemon auto-run the installer itself (still
pinned-version, still integrity-checked — just triggered automatically) on daemon startup
or on first spawn request for an agent it's never installed, since the daemon is the one
unattended process built for exactly this; (2) for Codex specifically, since a missing
`codex` CLI can't be auto-installed, detect that up front and report a clear, immediate,
web-visible error instead of a silent `spawnAwaiter` timeout; (2b) **also fix `startCodex.ts`
to call `notifyDaemonSessionStarted` on the success path** — right now a daemon-initiated
Codex spawn can never succeed even in the best case, which is a stronger bug than the
original entry captured; (3) an end-to-end test covering daemon-spawn → adapter-missing →
web-visible outcome, which doesn't exist today (the gap sits between `spawnEngine.test.ts`'s
mocks and `acpConnection.test.ts`, which never goes through the daemon — confirmed no test
references `notifyDaemonSessionStarted`/`session-started` from `startCodex.test.ts`).

**Status:** open, not started — re-verified 2026-07-28, still accurate and the Codex half
is confirmed more severe than originally documented.
