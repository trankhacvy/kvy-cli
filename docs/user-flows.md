# User flows + fix plan

Reference doc for Falcon's core usage scenarios and their real implementation status,
verified by live-testing (tmux + real Chrome MCP, 2026-07-19) and code tracing
(file:line citations below). Companion to `pty-continuation-brief.md` (which already
flagged the status-stuck bug as open problem #2) and `acp-delta-proposal.md` (ACP
migration context for the remote path).

Status legend: ✅ implemented · ⚠️ implemented but needs work · ❌ not implemented.

## The 5 flows

### 1. Started at my desk, walked away
Run `falcon claude` locally, work a while, physically leave. Something needs attention
(permission request, question, turn finishes) — get pinged on phone, act remotely.

- ✅ Session mirrors to web live; approving/denying a permission from web resolves the
  real local terminal dialog with zero physical input.
- ❌ **No push notification ever fires for a live permission/question/turn-done event.**
  Only a process **crash** pushes today. This breaks the flow's whole premise — today
  you must proactively re-open the app to discover anything needs you.

### 2. Check in from work
Session already running/finished at home. Check status from a browser at work, read
what happened, send a follow-up that types into the terminal remotely.

- ✅ Sending a follow-up from web injects into the real terminal; permission routing,
  deny-with-reason, AskUserQuestion round-trip, interrupt, and queueing all verified working.
- ⚠️ **"Working…" header gets stuck and never flips to Idle**, so you can't trust what
  you see when you check in. Also a stale "Queued" banner/bubble lingers after the
  queued message has already been answered.

### 3. Kick something off remotely
Not at any machine with the code. Open web, "New session," pick machine + folder, no
terminal involved at all.

- ✅ The wizard is real end-to-end (machine picker → directory browser → `spawn` machine
  RPC → daemon → live `falcon claude --starting-mode remote` process) — confirmed live
  and by code trace, not a stub.
- ⚠️ Only works for a folder already registered via `falcon workspace register` from a
  terminal. A genuinely fresh folder picked cold in the wizard fails at final submit
  (`unknown-workspace`), undercutting "no terminal needed."
- ⚠️ No dedup guard against starting two fresh sessions in the same directory from the wizard.

### 4. Pair with a teammate
Someone else views/approves your session live from their own device.

- ❌ **Not implemented at all** — no second-identity concept anywhere (schema, auth, or
  crypto). The DEK/pairing model hands a *new device* the whole account secret; there's
  no primitive for scoped, per-session access to a *different* person. Real feature
  work (new tables + a new crypto sharing primitive + authorization rewiring), not a
  thin UI addition. Out of scope for now per user direction — build 1–3 first.

### 5. "Oh wait, don't do that"
Catch a risky action and deny it before it executes, via a push notification.

- ❌ Same root cause as #1 — no push ever fires for a pending permission request.
- ✅ Timing is architecturally fine already: the permission hook blocks Claude Code
  before the tool runs and waits for an answer, so once the missing push call is wired,
  "notified before it happens" is immediate, not a race.

**Flows 1 and 2 are the same underlying experience** — "monitor and control a local
session while you're not looking at the terminal" — just two halves: get proactively
notified (1) vs. check in and trust the status (2). Fixing both closes the same
experience end-to-end. Flow 5 shares its blocker with flow 1 (the missing push call),
so wiring push once unlocks both. Flows 3 and 4 are separate initiatives, deferred.

---

## Fix plan: flows 1 & 2

### Target UX (what "done" looks like)

1. You walk away. The moment a permission request, a question, or a finished turn needs
   you, a push notification arrives — accurate, not spammy (suppressed if you're
   actively looking at the tab already).
2. Tapping it deep-links straight to the session, right at the thing needing you.
3. Whether you arrive via a notification or just check in cold, the status you see
   (session header, Home chip) is **always correct** — never a stale "Working…" for a
   turn that finished minutes ago.
4. You act (Allow/Deny/answer/reply) from web; it's reflected in the real terminal
   immediately, matching what's already verified working.
5. If you leave a follow-up while it's still working, "Queued" shows and clears
   accurately once actually injected — no stale leftover indicator.

### Root causes (already traced to file:line)

**A. Status stuck ("Working…" never clears / flow 2)**
- The session-detail header ORs a correct, always-fresh signal with a sticky one:
  `SessionTimelineScreen.tsx:94` — `ephemeralWorking || isTurnOpen(items)`. Home's
  equivalent (`session-list/status.ts`) uses `isTurnOpen` alone and is correct.
  `ephemeralWorking` (`use-session-ephemerals.ts`) is fed by a droppable "activity"
  ephemeral whose `working:false` companion can simply never arrive.
- Deeper cause: `isTurnOpen` itself only closes **retroactively**, the moment the
  transcript scanner sees the *next* user prompt (`envelopeMapper.ts`'s `closeTurn()`,
  called only from the `type:"user"` branch). Claude Code's own authoritative
  turn-finished signal — the `Stop` hook — **is already captured** by
  `remotePermissionHook.ts` / `start.ts`'s `onAttention("done")` handler, but that
  handler only does local PTY-gating bookkeeping and never emits anything over the
  wire. Nothing proactively closes a turn when it actually finishes.
- The stale "Queued" bubble is the same class of bug: a client-side indicator that
  isn't force-cleared once its event has actually been consumed.

**B. No push notifications (flows 1 & 5)**
- Server side is fully built and correct: `POST /v1/sessions/:id/notify` accepts
  `{kind: "perm"|"question"|"done"}` and dispatches through `buildPushDispatcher`,
  which correctly suppresses only when you have a genuinely active, foregrounded tab
  open on that session. Web push subscribe UI and the service worker's
  notification-click deep-link both work.
- **Nobody in the CLI ever calls that route.** The real permission-request emission
  (`pretoolPermissionBridge.ts`) only pushes a content envelope into the message
  outbox; `onAttention`'s `perm`/`question`/`done` cases in `start.ts` only flip a
  local in-memory flag. `reportSessionStatus` (the one real CLI→server status call)
  only fires on process **exit** (`failed`/`ended`), and only `failed` triggers a
  push — a normal successful completion while the process keeps running notifies no one.
- This is a missing call site, not a design problem — the hook that knows exactly when
  each of these three things happens already exists; it just needs to also make an
  HTTP call.

### Task list (ordered)

1. **Wire the CLI's known turn-completion signal onto the wire, proactively.**
   In `start.ts`'s `onAttention("done")` handler, use the already-threaded
   `emitEnvelope`/`outbox.enqueue` to send a real `turn-end` envelope the instant the
   `Stop` hook fires — not lazily, on the next prompt. Fixes `isTurnOpen` for both
   Home and the detail page, for real, at the source.
2. **Stop trusting the sticky ephemeral flag for the header.** In
   `SessionTimelineScreen.tsx`, derive `working` from `isTurnOpen(items)` alone
   (matching Home), or keep `ephemeralWorking` only as an early "just started" paint
   hint that a fresh `turn-end` in `items` always force-clears — never let it override
   a `false`.
3. **Fix the stale "Queued" indicator** to clear the moment its message is actually
   consumed/answered, not linger after the fact.
4. **Add the missing CLI→server `/notify` call.** Fire `POST /v1/sessions/:id/notify`
   with the right `kind` at the exact points already identified:
   - `kind: "perm"` — where `pretoolPermissionBridge.ts` currently only emits the
     perm-request envelope (before the tool executes — timing is already correct for
     "catch it before it happens").
   - `kind: "question"` — same call site, AskUserQuestion path.
   - `kind: "done"` — on a normal successful turn completion, not just process exit;
     safe to call unconditionally since the server's presence-suppression already
     decides whether a push is actually needed.
   Needs plumbing the session's auth/session token to this call site (today's hook
   server has no business owning it, per its own doc comment — reuse the same
   credential path `reportSessionStatus` already has).
5. **Live-verify end-to-end:** real push arrives on a phone/browser for perm and
   question events while away from the tab; confirm it's suppressed when the tab is
   open and focused; confirm the notification deep-links to the right session and the
   right pending item; confirm header/Home status is correct throughout without a
   reload, across multiple turns, with and without a follow-up message sent.

Deferred (separate initiatives, not in this plan): flow 3's workspace-registration gap
and spawn dedup guard; flow 4's teammate-sharing feature.
