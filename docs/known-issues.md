# Known issues

Tracks open issues found during testing/planning — why it's parked and what a real fix
needs. Resolved issues are removed once verified rather than kept as a growing archive;
history for anything previously listed here lives in git (this file's own commit log) and,
for the flows-3/4/5 track, in `docs/plan-flows-3-4-5.md`.

## Index

| # | Issue | Status |
|---|-------|--------|
| 1 | [Flow 4 ("pair with a teammate") is blocked on a human design review — `FL4.1`](#issue-1) | Blocked |
| 2 | [Automatic per-session git worktree isolation — deliberately deferred follow-ups](#issue-2) | Deferred |
| 5 | [Interactive prompts (permission / AskUserQuestion / plan approval) invisible to web when typed locally](#issue-5) | Open |
| 6 | [`falcon claude`/`falcon codex` never records a `workspaceId` — breaks 4 web panels](#issue-6) | Open |
| 7 | ["Repo root" header button opens a mostly-fake duplicate side panel](#issue-7) | Open |
| 8 | [A session never reconciles server-side if the machine dies without a clean exit](#issue-8) | Open |
| 9 | ["Idle" status doesn't distinguish a brand-new session from a genuinely dormant one](#issue-9) | Open |
| 10 | [Session card's relative timestamp reflects the wrong signal — not real chat activity](#issue-10) | Fixed |
| 11 | [Local Shift+Tab permission-mode changes only reach the web on the next tool call, and the web selector is read-only by default](#issue-11) | Open |
| 12 | [No model selector on the web — CLI→web model sync is one-way and only fires on a detected transcript change](#issue-12) | Landed (flag off) |
| 13 | [ACP adapter binaries are never auto-installed — remote/web-spawned sessions can silently fail or hang](#issue-13) | Open |
| 15 | [`falcon claude` self-recurses and dies silently when the shell shim is installed](#issue-15) | Open |

When an issue is resolved and verified, remove its row from this table and its section below
— don't mark it "Fixed" and leave it here, per this file's own no-growing-archive convention.

<a id="issue-1"></a>

## 1. Flow 4 ("pair with a teammate") is blocked on a human design review — `FL4.1`

**Where:** `docs/plan-flows-3-4-5.md`, execution unit `FL4.1`
("session-sharing-design-review"), Phase 2.

**What's open:** Flow 4 — letting a genuinely different person view/approve your session
from their own account/device — is not implemented and, more importantly, not yet
*designed*. There's no schema, no authorization model, and no invite flow decided for it.
The two implementation units that would build it (`FL4.3` schema/authz, `FL4.4`
socket/web UI) are explicitly blocked on `FL4.1` and must not start until it's done.

**What a real fix needs:** a written design doc (recommended path:
`docs/design-session-sharing.md`) that settles, at minimum:

- Threat/trust model for a second identity accessing someone else's session.
- The sharing schema (a `session_shares`-style table — per-session vs per-workspace scope,
  what roles exist: view-only vs. can-approve).
- The authorization-helper mechanism that replaces the ~15 existing
  `eq(sessions.accountId, accountId)` checks server-side.
- The RPC-routing fix for `packages/server/src/app/socket/rpcHandler.ts` — its rooms are
  keyed by the *caller's* account today, so a teammate's `perm.answer`/`message`/interrupt
  calls would silently resolve to nothing without this.
- The invite/handshake flow (how the owner learns a teammate's `contentPubKey`).
- Revocation semantics, including the honest fact that a key already delivered to a
  teammate's device can't be un-taught by revoking server-side access alone.

One piece is already de-risked and needs no new design: the crypto primitive
(`wrapDek`/`unwrapDek` in `packages/crypto/src/dek.ts`) already supports wrapping a
session's DEK to any content public key, not just the owner's — confirmed by a real
round-trip test (`FL4.2`, already landed).

**Status:** open, waiting on a human-authored and human-approved design doc. Not something
an automated workflow can produce or check off.

<a id="issue-2"></a>

## 2. Automatic per-session git worktree isolation — deliberately deferred follow-ups

**Where:** `docs/features/worktree-isolation.md` (all 6 phases landed).

**What's open:** four items the feature's own plan flagged as consciously out of scope for
this pass, not bugs:

- **Local `falcon -b <branch>` parity.** `args.ts` still parses `-b`/`--branch` but
  `commands/start.ts` never consumes it — local-mode sessions don't create a worktree at
  all today (only remote `spawn` does, via `gitWorktree.ts`). `index.ts`'s own help text
  advertises the flag, so this is a real CLI/remote parity gap, not just an omission.
  A real fix would call `ensureBranchWorkspace` before launching the local TUI, the same
  way `spawnEngine.ts` does for a remote spawn.
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

<a id="issue-5"></a>

## 5. Interactive prompts (permission / AskUserQuestion / plan approval) are invisible to the web when the turn was typed locally

**Where:** `packages/cli/src/claude/pretoolPermissionBridge.ts` (`handlePermissionRequest`,
`handleAskUserQuestion`, `isWebTurnActive`), `packages/cli/src/commands/start.ts:815-817`
(`markWebTurnStart`, only set inside `onInjected`).

**What's open:** every interactive tool that needs a human decision — a plain tool permission
prompt (Allow/Deny), `AskUserQuestion`, and `ExitPlanMode` (the plan-approve/reject prompt) —
all funnel through the same `handlePermissionRequest`/`handleAskUserQuestion` logic, and all
share the same gate: a live `perm-request` wire event is only emitted to the web when
`isWebTurnActive()` is true, i.e. the turn was injected *from* the web UI. If a human is
sitting at the real terminal and types directly (the common case), that flag is never set,
so:

- **Nothing is ever sent to the web while the prompt is pending.** Claude Code's own native
  terminal widget (3-option permission prompt, question picker, or plan approve/reject) just
  handles it locally, and the web session shows only a bare "Running" tool card with no
  buttons at all until it's answered locally — this affects all three tool types identically,
  confirmed for `ExitPlanMode` too (routed through the same generic path,
  `pretoolPermissionBridge.ts:286-291`).
- Push notifications for `kind:"perm"`/`"question"` DO still fire in this scenario
  (`onPendingAttention` is unconditional) — so a user gets a phone push saying a decision is
  needed, taps into the web session, and lands on that same dead-end running card with
  nothing to act on.
- **A real fix means changing the gate itself**, not just relaying more events: always emit
  the live prompt to web regardless of turn origin, then race the two possible answers (a
  keypress in the real terminal vs. a `perm.answer`/equivalent RPC from the web) — first one
  wins, the other is discarded/ignored. That's a real behavior change to
  `pretoolPermissionBridge.ts`'s decision logic, not a one-line fix.

**Additional, separate bugs found specifically on the `AskUserQuestion` card** (these exist
independently of the gating issue above — they're wrong even after an answer *is* recorded):

- **"(no answer recorded)" shows even when a real answer was given.**
  `AskUserQuestionToolCard.tsx:92` falls back to this literal whenever
  `parseAskAnswers(item.output)` (`packages/web/src/lib/tool-args.ts:401-426`) fails to match
  either of the two JSON shapes it guesses at — and its own doc comment admits neither shape
  is a *verified* real Claude Code tool-result shape. The real local tool_result apparently
  doesn't match either guess, so parsing silently returns `undefined` and the fallback fires
  even though the real answer is present in the raw output.
- **A raw, human-confusing internal string leaks into the UI**: "Your questions have been
  answered: ... You can now continue with these answers in mind." This text does not exist
  anywhere in Falcon's own code — it is Claude Code's own raw tool_result content, meant for
  the *model* to read, not a person. Because parsing fails (bug above), the card falls
  through to a generic JSON-dump component whose `stringify()` prints a plain string
  unquoted/raw (`packages/web/src/components/timeline/JsonBlock.tsx:51-53`) instead of being
  suppressed — so an internal, model-facing string ends up looking like part of the UI.
- **No free-text "enter your own answer" or "chat about this" affordance on the web card** —
  Claude Code's real terminal picker offers these alongside the fixed choices; the web
  `AskUserQuestionToolCard` only ever supports the fixed option list, and only once
  live-wired at all (see gating issue above). No existing plan/precedent for this in
  `docs/features/` — would be new work, not a missing wire-up of something already designed.

**What a real fix needs:** (1) the turn-origin-gating fix described above, shared across all
three tool types; (2) confirm the real, current Claude Code `AskUserQuestion` tool_result
shape (by capturing a live example) and fix `parseAskAnswers` to actually match it, removing
the raw-string leak as a side effect; (3) as a follow-up, real free-text + "chat about this"
support on the web card to match the terminal's own affordances.

**Status:** open, not started — three real user-reported bugs (this session), one shared root
cause plus two independent `AskUserQuestion`-card bugs and one scoped feature gap.

<a id="issue-6"></a>

## 6. `falcon claude`/`falcon codex` (plain terminal run) never records a `workspaceId` — breaks 4 web panels

**Where:** `packages/cli/src/commands/start.ts:441-459` (the `doBootstrapSession(...)` call),
`packages/cli/src/session/bootstrap.ts:239-261`, `packages/server/src/app/routes/sessions.ts:16-17,72`.

**What's open:** a session started the normal way — running `falcon claude`/`falcon codex`
directly in a terminal, in an arbitrary folder — never sends a `workspaceId` when the session
row is created. `start.ts`'s params object to `bootstrapSession()` has no `workspaceId` key at
all (not even `null`), so it falls through `bootstrap.ts`'s `params.workspaceId ?? null` and
the server (`CreateSessionBodySchema`'s `workspaceId` is optional/nullable, no server-side
fallback/auto-create) just stores `null`. `machineId` is fine — `start.ts` hard-fails the
command if that's missing, so it's always populated; **only `workspaceId` is the gap.**

The only path that DOES populate `workspaceId` is the daemon's `spawn` RPC
(`daemon/spawnEngine.ts`, used by the web "New Session" wizard / remote spawn) — it registers
a workspace and resolves/passes its id before launching. A bare terminal `falcon claude` run
skips that registration step entirely.

**Blast radius:** every web panel that gates on `session.machineId`/`session.workspaceId` both
being present shows the same "This session has no machine/workspace recorded yet" message for
any session started this way — confirmed to affect all four: **Files changed** (git diff),
**Checks**, **Repo files**, and **Setup / Run**. This is the common, everyday way to start a
session (a bare terminal command, not the web wizard), so this is a high-impact, previously
undocumented gap.

**What a real fix needs:** have `start.ts`'s local-PTY path resolve/register a workspace for
its `workingDirectory` (reusing `workspace/registry.ts`'s register-or-resolve logic, the same
way `spawnEngine.ts` does) before calling `bootstrapSession()`, and thread the resulting id
through as `workspaceId`.

**Status:** open, not started — newly found, not previously documented anywhere.

<a id="issue-7"></a>

## 7. "Repo root" header button opens a mostly-fake duplicate side panel

**Where:** `packages/web/src/components/timeline/SessionTimelineScreen.tsx:274-283` (the
`FolderGit2`-icon `panelOpen` toggle), `packages/web/src/components/timeline/SessionSidePanel.tsx`.

**What's open:** this button (labeled "Repo root") toggles a 3-tab side panel — Changes / Repo
Files / Checks — that duplicates the header's own dedicated "Files changed"/"Repo files"/
"Checks" pages, but almost entirely with fake data:

- **Changes tab** renders a hardcoded `DUMMY_CHANGES` array — the component's own comment
  admits "no git backend wired here yet," even though the real git data already exists
  (that's exactly what "Files changed" shows correctly elsewhere in the same header).
- **Repo Files tab** renders a hardcoded, non-interactive fake file tree of literal path
  strings — not connected to the real, already-live Repo Files feature.
- **Commit/push/refresh/search controls** in this panel are all `disabled`, with tooltips
  literally saying "isn't wired up yet."
- Only the **Checks tab** is real (it reuses the live `ChecksPanel`).
- `SessionSidePanel.tsx`'s own doc comment calls itself "mostly still placeholder UI" — this
  isn't a subtle regression, it's acknowledged in-code.
- The "Repo root" label doesn't match what it opens either (defaults to the fake Changes tab,
  not a file tree) — reads like leftover copy from an earlier "Cursor-style side panel"
  iteration that predates the now-real dedicated pages.

**What a real fix needs:** either remove this button/panel entirely (the dedicated
Files-changed/Repo-files/Checks pages already cover this, live), or, if a side-panel-without-
navigating-away UX is still wanted, rewire its Changes/Repo Files tabs to reuse the same
already-live `git-diff`/`repo-files` hooks instead of maintaining a second, fake data path.

**Status:** open, not started — newly found, not previously documented anywhere.

<a id="issue-8"></a>

## 8. A session never reconciles server-side if the machine dies without a clean exit

**Where:** `packages/cli/src/commands/start.ts` (`onSignal`/`reportStatusOnce`, the
clean-exit/SIGTERM/SIGHUP paths), `packages/cli/src/daemon/readoptSessions.ts`
(`findLiveOrphanedSessions`), `packages/cli/src/daemon/sessionRegistry.ts`
(`pruneDeadSessions`).

**What's open:** a clean `/exit`, or the terminal window closing (`SIGHUP`), or the wrapper
process receiving `SIGTERM`, are all handled correctly — each reliably reports
`status: "ended"`/`"failed"` to the server before exiting (the wrapper explicitly awaits that
report before actually terminating). But if the machine loses power, is hard-killed, or the
process dies before that signal handler can run, **nothing ever reports the session's true
status.** The DB row stays `status: "active"` forever — there is no timeout anywhere that
flags it. Even the *next* time a daemon starts on that machine, its boot-time reconciliation
(`findLiveOrphanedSessions`) only re-adopts sessions whose pid is still alive; for a pid
that's gone, it does nothing at all — no call back to the server, ever.
`sessionRegistry.ts`'s `pruneDeadSessions()` (runs every heartbeat tick while a daemon IS
running) only moves the dead entry into a local "resumable" bookkeeping map for later
`resumeSession` — it never calls `POST /v1/sessions/:id/status` either.

**Impact:** a user who kills their laptop mid-session sees that session sit as "active"
(controls enabled, no lifecycle banner) in the web UI indefinitely, with no self-healing —
purely cosmetic/misleading, since nothing can actually reach the real (gone) process anymore,
but confusing and never resolves on its own.

**What a real fix needs:** a server-side staleness check — e.g. treat a session as
functionally dead if its machine has been offline (no heartbeat) past some window AND the
session was never cleanly closed, and flip it to `"failed"` automatically, rather than relying
solely on the originating process getting a chance to self-report.

**Status:** open, not started — newly found, not previously documented anywhere.

<a id="issue-9"></a>

## 9. "Idle" status doesn't distinguish a brand-new session from a genuinely dormant one

**Where:** `packages/web/src/features/session-list/status.ts` (`deriveSessionStatus`,
`SESSION_STATUS_META`).

**What's open:** the Home screen's per-session status badge is not the session's DB
lifecycle state (that really does stay `"active"` the whole time the process is alive) — it's
a separate, more granular "what's happening right now" signal: failed/ended/archived → those
labels, offline machine → "Offline", pending permission → "Needs permission", agent asked a
question → "Needs input", an open turn → "Working", and otherwise it falls back to **"Idle"**.

That fallback is technically accurate (nothing is happening right now) but conflates two very
different situations under one identical label: a session that was just created and has never
had a single turn yet, and a session that's been used productively for a while and is
momentarily quiet between messages. Both show "Idle" with no way to tell them apart from the
Home screen — a first-time user starting `falcon claude` and opening the web UI sees the exact
same badge a long-dormant session would show, which reads as less informative/slightly
concerning ("is this actually connected?") than it should for a freshly-started, healthy
session.

**What a real fix needs:** not a rename to "Active" (that would collide with the existing
lifecycle-status meaning, and would be equally mislabeled the moment a used session goes
quiet). Instead, add a distinct state — e.g. "Ready" — for a session with zero turns in its
history yet, keeping "Idle" for the between-turns case where real history exists. A small
naming/state-modeling fix, not a functional bug.

**Status:** open, not started — newly found, not previously documented anywhere.

<a id="issue-10"></a>

## 10. Session card's relative timestamp reflects the wrong signal — not real chat activity

**Where:** `packages/web/src/features/session-list/components/session-card.tsx:45`
(`formatRelativeTime(session.updatedAt)`), `packages/server/src/app/routes/sessionCas.ts:71,76`,
`sessionStatus.ts:95`, `sessionArchive.ts:65,130`, `notificationSettings.ts:107`,
`packages/server/src/db/schema.ts` (`sessions.updatedAt`).

**What's open:** the Home screen's per-session card shows a relative time
("just now"/"5m"/"2h") derived from `sessions.updatedAt`, framed to the user as "when was this
session last touched." But `updatedAt` is **only** written by four narrow code paths: muting
notifications, archiving/restoring, an `agentState` (permission-mode/pending-permission) CAS
write, or an explicit status change (ended/failed). **Sending or receiving an ordinary chat
message never touches it** — `packages/server/src/app/routes/messages.ts` inserts into the
separate `sessionMessages` table and never updates the owning `sessions` row at all. So the
timestamp shown is not "last chat activity" — it's "last time one of those four unrelated
side-events happened to fire," which can make it look wrong in either direction: too stale (a
long, active, plain-text conversation with no permission events never bumps it) or, as
reported, misleadingly fresh (some incidental `agentState`/status write landing recently even
though the user's real last interaction was much earlier).

One specific hypothesis was investigated and **ruled out** with a real reproduction: a
timezone-drift theory (the columns use `timestamp()` without `withTimezone: true`, and the
dev machine's timezone is `Asia/Saigon`, UTC+7). Confirmed via a direct test against
`drizzle-orm`'s actual postgres-js driver in `node_modules` that this is NOT a bug — Drizzle
disables the underlying driver's own timestamp parser and does its own UTC-safe parsing
(explicitly appends `+0000` before constructing the `Date`). So the columns' lack of
`withTimezone: true` is not implicated here.

**What a real fix needs:** bump `sessions.updatedAt` on real message activity too (e.g. from
the same write path `messages.ts` already uses to allocate `msgSeq`), not just on the four
current incidental triggers — so the Home screen's timestamp actually reflects what it claims
to.

**Status:** Fixed — `allocMsgSeq` (`packages/server/src/db/seq.ts`), the atomic
`msg_seq + 1` update every `messages.ts` POST already goes through, now also sets
`updatedAt: new Date()` in the same statement, so real chat activity bumps the column.

The exact
trigger that produced "just now" for the reporter's specific 1-hour-old session was not
pinned down with live data (would need the raw `updatedAt` value from a live `/v1/sync`
response to confirm precisely), but the structural gap (chat messages never bump this field)
is confirmed by code and is real regardless of the exact reproduction.

<a id="issue-11"></a>

## 11. Local Shift+Tab permission-mode changes only reach the web on the next tool call, and the web selector is read-only by default

**Where:** `packages/cli/src/claude/pretoolPermissionBridge.ts:484-517`
(`cachePermissionMode`), `packages/web/src/components/timeline/mode-switch-state.ts`
(`canMutateMode`), `packages/web/src/components/timeline/ComposerControls.tsx:98-117`,
`packages/web/src/lib/config.ts` (`PTY_SET_MODE_ENABLED`).

**What's open:** two separate, stacking gaps between a local terminal's Shift+Tab
permission-mode cycle (Default / Accept edits / Plan / ...) and the web's mode chip:

- **Detection latency.** `cachePermissionMode` was specifically built to catch a local
  Shift+Tab and emit a live `permission-mode` wire event (per its own doc comment, referencing
  `docs/bug-fix-plan.md §5`) — but it only observes the current mode opportunistically off
  Claude Code's own tool-permission hook payload. That means a mode change is only detected
  **the next time a tool call happens**, not the instant Shift+Tab is pressed. Cycling modes
  without triggering a subsequent tool call leaves the web showing a stale mode indefinitely.
- **Read-only selector by default.** Even once a mode change IS detected and reflected, the
  web's mode control only becomes a real, interactive dropdown for a local/PTY session when
  `NEXT_PUBLIC_FALCON_PTY_SETMODE=1` is set (`canMutateMode`) — off by default. Without it,
  the web shows a correct label at best, as plain non-interactive text, with no way to change
  the mode from the web side for a local session.

(Bypass-permissions not appearing in a Shift+Tab cycle is genuine Claude Code CLI behavior —
unrelated to Falcon, not a bug here.)

**What a real fix needs:** a detection path that doesn't wait on the next tool call (e.g. a
dedicated hook/signal fired directly off the mode-cycle keystroke itself, if Claude Code
exposes one), and a decision on whether/when to flip `PTY_SET_MODE_ENABLED` on by default now
that the underlying `setMode`-via-PTY-injection mechanism exists.

**Status:** open, not started — newly found, not previously documented anywhere.

<a id="issue-12"></a>

## 12. No model selector on the web — CLI→web model sync is one-way and only fires on a detected transcript change

**Where:** `packages/wire/src/rpc.ts` (`SetModelParamsSchema`/`SetModelResultSchema`,
`RUNNING_SESSION_MODEL_ALIASES`), `packages/cli/src/claude/ptyClaudeSession.ts`
(`sendModelChange`, the "Switch model?" confirm-dialog watcher), `packages/cli/src/commands/start.ts`
(`setModel` RPC handler, flag-gated behind `FALCON_PTY_SETMODEL`), `packages/web/src/components/timeline/ComposerControls.tsx`
(the "Change model" selector + the model chip's "Model unknown" fallback), `packages/web/src/components/timeline/model-switch-state.ts`.

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

**Status:** landed behind a flag, not yet live-soaked — same status class as issue #11's
`setMode`. Remove this entry once the flag has been soaked and flipped on by default.

<a id="issue-13"></a>

## 13. ACP adapter binaries are never auto-installed — remote/web-spawned sessions can silently fail or hang

**Where:** `packages/cli/src/adapters/manifest.ts`, `install.ts`, `verify.ts`, `spawn.ts`
(the adapter manager); `packages/cli/src/acp/acpConnection.ts` (`connect()` refuses if
verification fails); `packages/cli/src/commands/adapters.ts` (the only caller of the
installer — `falcon adapters install|upgrade`); `packages/cli/src/daemon/spawnEngine.ts`
(the `spawn` RPC handler); `packages/cli/src/commands/start.ts:587`
(`notifyDaemonSessionStarted`, Claude-only); `packages/cli/src/commands/startCodex.ts`
(never calls `notifyDaemonSessionStarted`, and hard-exits before bootstrap if the real
`codex` CLI isn't on PATH).

**What's open:** each supported agent (`claude-code`, `codex`) is a separate npm package
(`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`), installed
into `~/.falcon/adapters/` via a pinned-version, integrity-checked `npm install` — but
that install is **only ever triggered manually**, by a user running
`falcon adapters install`/`upgrade`. Nothing calls it automatically: no `postinstall` hook
on the `falcon` package itself, and no lazy-install on first use — `AcpConnection.connect()`
just throws `AcpConnectionError` if the adapter isn't already verified-installed.

That's a tolerable UX for a local terminal user (they see the error, run the install
command themselves). It breaks down for sessions spawned from the web, where nobody is
watching that machine's terminal:

- **Claude:** the daemon's `spawn` RPC reports "session started"
  (`notifyDaemonSessionStarted`) right after bootstrap, *before* the adapter is ever
  touched. The web UI shows a session that looks live, then the failure surfaces later as
  a confusing in-transcript message ("Remote session failed to start: ACP adapter ...
  not-installed") — no proactive install offered, no upfront error.
- **Codex is worse.** `commands/startCodex.ts` never calls `notifyDaemonSessionStarted` at
  all (confirmed the only provider command that doesn't), and separately hard-exits before
  bootstrap if the real `codex` CLI binary isn't on PATH — a second dependency Falcon
  can't fix by installing its own package. A daemon-initiated Codex spawn on a machine
  missing either dependency likely just hangs until the web UI's own spawn-await times
  out, with no clear error surfaced anywhere. This path isn't proven end-to-end either
  way — `docs/plan.md` itself marks Codex web-spawn E2E as "pending."

**What a real fix needs:** (1) have the daemon auto-run the installer itself (still
pinned-version, still integrity-checked — just triggered automatically) on daemon startup
or on first spawn request for an agent it's never installed, since the daemon is the one
unattended process built for exactly this; (2) for Codex specifically, since a missing
`codex` CLI can't be auto-installed, detect that up front and report a clear, immediate,
web-visible error instead of a silent `spawnAwaiter` timeout; (3) an end-to-end test
covering daemon-spawn → adapter-missing → web-visible outcome, which doesn't exist today
(the gap sits between `spawnEngine.test.ts`'s mocks and `acpConnection.test.ts`, which
never goes through the daemon).

**Status:** open, not started — newly found, not previously documented anywhere.

<a id="issue-15"></a>

## 15. `falcon claude` self-recurses and dies silently when the shell shim is installed

**Where:** `packages/cli/src/provider/claudeCliLocator.ts:153-162` (`findClaudeInPath`'s
existing shim-skip guard), `packages/cli/src/session/sessionLock.ts` (the
per-`(machineId, workspacePath)` live-pid lock that fires when the recursion collides
with itself), `packages/cli/src/shim/` (`falcon shim install`, FR-9.6).

**What's open:** found while E2E-testing the CLI auth changes, unrelated to that diff.
On a machine with `falcon shim install` active (`~/.falcon/bin/claude` →
`exec falcon claude "$@"`, prepended to PATH ahead of the real `claude`), a real
`falcon claude` session dies right after printing "starting session", with no error
explaining why, confirmed 100% reproducible via debug logs showing a SECOND, nested
`main()` invocation with argv like `[..., "--append-system-prompt", "--settings",
".../session-hook-....json"]` — Claude-Code-internal flags, not anything Falcon passed.
`parseArgs`'s catch-all (by design, for verbatim flag passthrough — see `args.ts`) treats
that nested invocation as a fresh default-provider start, which then collides with the
*outer* invocation's own just-acquired session lock for the same working directory
(`sessionLock.ts`) and exits 1 — silently killing the whole session.

Falcon's own locator already has an anti-recursion guard for exactly this class of
problem: `findClaudeInPath` explicitly skips a `claude` resolved to `shimBinDir()` and
falls through to npm/Bun/Homebrew/native-installer detection instead
(`claudeCliLocator.ts:153-162`, itself written to prevent this same failure mode for
Falcon's own initial CLI-path resolution). That guard evidently does not cover whatever
internal mechanism produces the SECOND, nested invocation observed here — root cause of
that specific recursion trigger (most plausibly something inside the real Claude Code
process itself shelling out to a bare `claude` — e.g. for hook execution — which goes
through the shell's PATH and hits the shim, rather than reusing Falcon's already-resolved
absolute path) was not pinned down further; flagging the confirmed symptom and workaround
rather than asserting an unverified exact mechanism.

**Confirmed workaround:** stripping `~/.falcon/bin` from PATH avoids the recursion
entirely. This affects anyone who's completed the (encouraged, FR-9.6) shim onboarding
prompt — likely a meaningful fraction of real users, not an edge case.

**What a real fix needs:** trace exactly what spawns the nested `claude` invocation
(most likely inside the real Claude Code process, not Falcon's own code) and either make
that call site resolve an absolute path the same way `findGlobalClaudeCliPath` does, or
extend the shim script itself to detect (and refuse, or transparently exec the real
binary for) a re-entrant call so recursion can't happen regardless of who triggers it.

**Status:** open, not started — newly found, not previously documented anywhere.
