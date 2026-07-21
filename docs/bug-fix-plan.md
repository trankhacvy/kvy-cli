# Bug fix plan — live E2E pass (2026-07-21)

This is an implementation/fix plan for 13 issues found during an exhaustive live end-to-end
test pass of Falcon: real `tmux` CLI sessions (`falcon claude`) driving a real Claude Code
process, exercised against a real Chrome browser (MCP-automated) hitting a real running
server, with **server-side decryption used to verify some findings directly against stored
ciphertext** — several of these are not guesses, they were confirmed against real data
(most notably #1, the cross-session leak). It complements `docs/user-flows.md`, which is a
narrower, earlier fix plan (2026-07-19) for a specific pair of related bugs — the stuck
"Working…" status and missing push notifications; this document's item #2 is that same
"Working…" bug, now independently re-verified as fixed. Sections are ordered by severity
(critical first), per the triage ranking that shaped this test pass.

Every "Root cause" section below cites and quotes the actual current source read during
this pass, not a paraphrase of the original bug report — the code was re-read fresh for
this document, and one issue (#2) turned out to already be fixed earlier in the same
session it was found in.

---

## 1. [CRITICAL] Cross-session content leak via the directory-wide fallback watcher

### Problem

`falcon claude`'s transcript tailer (`packages/cli/src/claude/scanner.ts`) watches the
*entire* Claude Code project transcript directory (`~/.claude/projects/<project-id>/`) as a
fallback for when the `SessionStart` hook doesn't fire. That directory is shared by *every*
Claude Code process running against the same working directory on the machine — including
completely unrelated sessions in other terminals. The fallback watcher treats **any**
`.jsonl` file it hasn't personally seen before as proof that *its own* tracked session
rotated. Live repro: a `falcon claude --model haiku` session whose own transcript file was
slow to appear (>60s — hit the "session transcript never appeared — dropping" path) later
had its dropped session slot silently reattached to a totally unrelated, already-running
session's transcript file. The server ended up storing that *other* session's real message
content under the test session's id — confirmed by decrypting the actual stored ciphertext.

### Root cause

`packages/cli/src/claude/scanner.ts:201-270` (`watchProjectDirectoryForNewSessions`) fires
its callback for *any* new-to-this-`fs.watch()`-instance `.jsonl` file:

```ts
// scanner.ts:233-249
for await (const event of watcher) {
  if (abortController.signal.aborted) return;
  const fileName = event.filename;
  if (!fileName?.endsWith(".jsonl")) continue;
  const sessionId = fileName.slice(0, -".jsonl".length);
  if (!sessionId) continue;

  const existing = debounceTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  debounceTimers.set(
    sessionId,
    setTimeout(() => {
      debounceTimers.delete(sessionId);
      onNewFile(sessionId);
    }, NEW_SESSION_ROTATION_DEBOUNCE_MS),
  );
}
```

There is no check anywhere that `sessionId` belongs to *this* scanner's own child process —
"new" is judged purely by "an `fs.watch` rename event for a filename I haven't debounced
before," which is true for literally any sibling session's brand-new transcript file too.

The callback wired up in `createSessionScanner` (`scanner.ts:469-481`) treats that signal as
gospel and calls the exact same `announceNewSession` the real hook path uses:

```ts
// scanner.ts:469-481
const stopDirectoryWatcher = watchProjectDirectoryForNewSessions(
  projectDir,
  (newSessionId) => {
    if (stopped) return;
    if (newSessionId === currentSessionId) return;
    logger.info("[SESSION_SCANNER] new transcript file detected — rotating session (fallback)", {
      newSessionId,
      previousSessionId: currentSessionId,
    });
    void announceNewSession(newSessionId);
  },
  logger,
);
```

And critically, `announceNewSession` (`scanner.ts:426-458`) *revives* a previously
give-up-on session id unconditionally:

```ts
// scanner.ts:434-438
// The caller explicitly re-announces this session, so give a
// previously-dropped id another chance (its file may exist now).
if (deadSessions.delete(sessionId)) {
  logger.debug("[SESSION_SCANNER] reviving previously-dropped session", { sessionId });
}
```

This revival makes sense for the **hook-confirmed** path (Claude Code legitimately
re-announcing the same id after a reconnect). It makes no sense for the **fallback**
path, which has zero actual correlation to "this is my own process" — it's purely "a file
with some other name appeared in a directory I'm also watching." Once the tracked
session's own file failed to appear and its id was dropped (`onGaveUp`,
`scanner.ts:351-364`), the very next unrelated sibling session's transcript file to appear
— seconds, minutes, or hours later — gets adopted as if it were this session's own
rotation, and the tailer starts reading and forwarding *that* session's real messages
under this session's identity.

The directory watcher also has no lifetime bound: it runs for the entire life of the
scanner (`scanner.ts:190-199`'s own doc says it's "meant to outlive the whole session"),
so the exposure window is not "a few seconds around startup," it's the session's entire
runtime.

### Proposed fix

The fallback watcher is inherently a filesystem-only heuristic — it cannot, from a bare
`rename` event, prove a new file belongs to the specific child process this scanner is
tailing. The fix is to shrink its authority to match what it can actually vouch for:

1. **Stop trusting the fallback once the hook path has ever fired for real.** The current
   v2 architecture (`ptyClaudeSession.ts`'s module doc) already expects exactly one shared
   hook server per session providing `SessionStart`, so the fallback is genuinely only
   needed when hook coverage is absent or hasn't landed yet. Track that explicitly:

   ```ts
   // scanner.ts — new state alongside the existing mutable scanner state
   // (near `deadSessions`/`currentSessionId`, createSessionScanner ~line 284)
   let hookConfirmed = opts.sessionId !== null;
   ```

   and set it inside the **public**, caller-driven entry point only:

   ```ts
   // scanner.ts — the returned object at the bottom of createSessionScanner
   return {
     cleanup: /* unchanged */,
     flush,
     onNewSession: async (sessionId, options) => {
       hookConfirmed = true;
       await announceNewSession(sessionId, options);
     },
   };
   ```

   Then gate the directory-watcher callback on it:

   ```ts
   // scanner.ts:469-481, replacing the unconditional void announceNewSession(newSessionId)
   const stopDirectoryWatcher = watchProjectDirectoryForNewSessions(
     projectDir,
     (newSessionId) => {
       if (stopped) return;
       if (newSessionId === currentSessionId) return;
       if (hookConfirmed) {
         // A hook has already proven this scanner has real SessionStart
         // coverage — a *different* file appearing is almost certainly a
         // sibling session sharing this directory, not our own rotation.
         // Never adopt it (plan-v2.md / bug-fix-plan.md #1).
         logger.debug(
           "[SESSION_SCANNER] ignoring unrelated new transcript file (hook coverage active)",
           { newSessionId, currentSessionId },
         );
         return;
       }
       logger.info(
         "[SESSION_SCANNER] new transcript file detected — rotating session (fallback, no hook coverage)",
         { newSessionId, previousSessionId: currentSessionId },
       );
       void announceNewSession(newSessionId);
     },
     logger,
   );
   ```

2. **Never let the fallback revive a dropped (`deadSessions`) id.** Whatever legitimate
   value "revive on re-announce" has, it belongs only to the hook path. Split
   `announceNewSession`'s revival branch so the fallback-sourced call path can't hit it —
   simplest is to pass a `source` flag through and skip the `deadSessions.delete(...)` when
   `source === "fallback"`, denying the fallback the ability to resurrect anything it can't
   independently verify.

3. **Time-box the fallback's authority even in the no-hook case.** The only legitimate use
   case for the directory-wide fallback is "a rotation *just* happened and the hook didn't
   fire for it" — not "grab whatever file shows up at any point across an hours-long
   session." Arm it only for a bounded window after scanner start (and again briefly after
   an `onGaveUp`), rather than for the scanner's entire lifetime:

   ```ts
   const FALLBACK_ARMED_WINDOW_MS = 30_000;
   let fallbackArmedUntil = Date.now() + FALLBACK_ARMED_WINDOW_MS;
   // ... inside the directory-watcher callback, before the hookConfirmed check:
   if (Date.now() > fallbackArmedUntil) {
     logger.debug("[SESSION_SCANNER] ignoring new transcript file — fallback window expired", {
       newSessionId,
     });
     return;
   }
   ```

**Residual risk, stated honestly:** for a genuinely hookless install (native Claude Code
binary, or a broken `--settings` wiring), a directory-wide fallback watcher fundamentally
cannot *prove* a new file is "mine" from filesystem metadata alone — two truly concurrent,
hookless sessions in the same directory remain ambiguous in principle. The fix above closes
the exposure for the overwhelmingly common case (hook coverage present, which is the
default architecture today) and shrinks the no-hook window from "the whole session" to a
bounded ~30s, which is a large, concrete improvement, not a full elimination of the
theoretical hookless case. A stronger fix (deferred, larger scope) would cross-reference the
candidate file's very first parsed entry's timestamp/PID lineage against the actual child
process this scanner spawned (via the process-scanning utilities `daemon/transcriptIndexer.ts`
already uses for a similar liveness problem) before ever adopting it.

### Testing notes

- Extend `packages/cli/src/claude/scanner.test.ts`: spin up a scanner tracking session A in a
  temp project dir, call `onNewSession("A", ...)` once (simulating the hook), then create a
  *second*, unrelated `B.jsonl` file in the same directory with its own content. Assert the
  scanner never emits B's entries and `currentSessionId` never becomes `"B"`.
- Repeat without ever calling `onNewSession` (simulating no hook coverage) and confirm the
  fallback still rotates onto `B` — the no-hook path must keep working, just time-boxed.
- Repeat the original live repro (two real `tmux` panes, same cwd, one session force-delayed
  past `missingFileTimeoutMs`) and confirm via server-side decryption that the delayed
  session's stored messages never contain the other pane's content.

---

## 2. [Already fixed] Stuck "Working…" status

### Status: already fixed in `packages/web/src/features/session-control/session-state.ts`

This was fixed earlier in the same session that produced this report — verify no
regression rather than re-implementing it.

`packages/web/src/features/session-control/session-state.ts:65-71`'s `deriveWorking` now
treats `isTurnOpen(items)` (freshly re-derived from the persisted, canonical event stream
on every call) as authoritative:

```ts
export function deriveWorking(items: RenderItem[], ephemeralWorking: boolean): boolean {
  if (isTurnOpen(items)) return true;
  const hasTurnHistory = items.some(
    (item) => item.kind === "turn-start" || item.kind === "turn-end",
  );
  return !hasTurnHistory && ephemeralWorking;
}
```

The previously-buggy computation (documented in this same function's own comment, and in
`docs/user-flows.md`'s root-cause section A) was `ephemeralWorking || isTurnOpen(items)` at
`SessionTimelineScreen.tsx:94` — a droppable "activity" ephemeral could permanently mask a
correct, closed `isTurnOpen` signal. The fix inverts the priority: `ephemeralWorking` now
only ever contributes *before* any turn history exists at all (a brand-new session, or one
whose first page hasn't loaded), and is unconditionally retired the instant a single
`turn-start`/`turn-end` has landed — it can never re-assert `working: true` after a real
`turn-end` has closed the turn. `SessionTimelineScreen.tsx:100` now calls this function
directly (`const working = deriveWorking(items, ephemeralWorking);`), matching Home's own
(`features/session-list/status.ts`) always-correct `isTurnOpen`-based computation.

The companion race this same fix-plan flagged — Claude Code's `Stop` hook firing before its
own final-message transcript write has landed on disk — is also handled, in
`packages/cli/src/claude/ptyClaudeSession.ts:96-119` (`CLOSE_TURN_MAX_ATTEMPTS` /
`CLOSE_TURN_RETRY_DELAY_MS` / `CLOSE_TURN_QUIET_FLUSHES_REQUIRED`): `closeTurn` now retries
`scanner.flush()` up to 5 times, requiring 2 *consecutive* quiet passes (no new entries)
before trusting the transcript has actually settled, rather than closing the turn on a
single flush that could land mid-write.

A dedicated regression test already exists and explicitly documents the bug it guards
against: `packages/web/src/features/session-control/__tests__/session-state.test.ts:177-219`,
specifically the case named *"never lets a stuck-true ephemeral override a turn that has
already closed (the reported bug)"* (lines 192-201). No further test is needed for this
exact regression; if anything, add one assertion to `SessionTimelineScreen`'s own render
test confirming it calls `deriveWorking(items, ephemeralWorking)` (not the old OR-based
inline expression) so a future refactor can't silently reintroduce the inline form.

---

## 3. Message list not scrollable

### Problem

The session timeline's message list does not scroll. Confirmed via live JS inspection:
`scrollHeight` was ~3x `clientHeight` on the relevant container, and scroll actions
(wheel/keyboard/programmatic `scrollTop`) had zero visible effect.

### Root cause

`packages/web/src/components/timeline/SessionTimelineScreen.tsx:228` wraps the actual
scrollable `Timeline` component in a plain block `<div>` that is **not** a flex container:

```tsx
// SessionTimelineScreen.tsx:228-239
<div className="min-h-0 flex-1 overflow-hidden">
  {isInitialLoading && items.length === 0 ? (
    <TimelineSkeleton />
  ) : (
    <Timeline
      items={mergedItems}
      working={working}
      hasMore={hasMore}
      isLoadingMore={isLoadingMore}
      onLoadEarlier={onLoadEarlier}
    />
  )}
</div>
```

This div correctly receives a *definite, bounded* pixel height from its own parent (it's a
flex item — `flex-1`/`min-h-0` — inside `SessionTimelineBody`'s outer flex-col at
`SessionTimelineScreen.tsx:189`), and it has `overflow-hidden`, so it *does* establish a
clipping boundary. But its single child — `Timeline`'s `Conversation` component
(`packages/web/src/components/ai-elements/conversation.tsx:13-21`) — relies on Tailwind
utility classes to size itself:

```tsx
// Timeline.tsx:72-73
<Conversation
  className="min-h-0 flex-1 px-4"
  ...
>
```

```tsx
// conversation.tsx:13-21
export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 min-h-0 overflow-x-hidden overflow-y-auto", className)}
    ...
  />
);
```

`flex-1`/`min-h-0` on `Conversation` only have any effect if **its own parent** is a flex
container (`display: flex`). The wrapping `<div className="min-h-0 flex-1 overflow-hidden">`
at line 228 has no `flex` class of its own — it's a normal block box. A normal block box
does not stretch its children to its own height; a block-level child's height is
auto/content-based unless explicitly told otherwise. So `Conversation` (the actual
`overflow-y-auto` scrollport, meant to be the thing that scrolls) never gets constrained to
the available viewport height — it grows to fit its full rendered transcript content
instead. Its own `overflow-y-auto` never has anything to do (nothing overflows *its own*
unconstrained box), and the ancestor at line 228, which *does* have a definite bounded
height plus `overflow-hidden`, is the one everything actually overflows into — and
`overflow: hidden` clips silently with no scrollbar and no scroll interaction at all. This
matches the reported symptom exactly: the *container*'s `scrollHeight` (its content's real
height) ends up a multiple of its `clientHeight` (its own bounded box), and because its
overflow mode is `hidden` rather than `auto`/`scroll`, nothing can scroll it.

### Proposed fix

Make the line-228 wrapper an actual flex container so `Conversation`'s `flex-1 min-h-0`
classes take effect and it gets properly height-constrained (then its own
`overflow-y-auto` is what does the real scrolling):

```tsx
// SessionTimelineScreen.tsx:228 — before
<div className="min-h-0 flex-1 overflow-hidden">

// after
<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
```

`flex-col` isn't strictly required for correctness with a single child (default `row`'s
cross-axis stretch already gives the child the container's height), but it keeps the
intent obvious and matches every other flex-col wrapper in this same file
(`SessionTimelineBody`'s outer div at line 189, `mx-auto flex h-full min-h-0 ... flex-col`).

### Testing notes

- Manual repro: open a session with enough transcript content to exceed one viewport
  (e.g. several long tool outputs), confirm the message list scrolls with mouse wheel and
  that `ConversationScrollButton` (the "jump to bottom" affordance) appears once scrolled up.
- In dev tools, confirm the div at `SessionTimelineScreen.tsx:228` now computes
  `getComputedStyle(el).display === "flex"`, and that `Conversation`'s own root element's
  `scrollHeight > clientHeight` while its `clientHeight` now matches the visible viewport
  region (not the full transcript height).
- No existing automated test currently renders the full `SessionTimelineScreen` tree with
  overflowing content in a sized viewport (jsdom doesn't compute real layout, so this class
  of bug is invisible to unit tests) — if a Playwright/browser-driven test harness exists
  for this app, add a scroll-affordance check there rather than in vitest/jsdom.

---

## 4. Model-switch-to-Haiku message renders raw XML/ANSI

### Problem

Switching models locally (a Claude Code `/model` command) produces a chat bubble that shows
raw escape sequences and/or Claude Code's own slash-command transcript wrapper instead of a
clean "switched to Haiku" message.

### Root cause

`packages/cli/src/claude/modelChange.ts` exists and is wired in, but only as a **side
channel for session metadata** — it does not sanitize what actually gets shown in the chat
transcript. `packages/cli/src/commands/start.ts:612-621`:

```ts
const handlePossibleModelChange = (envelopes: readonly SessionEnvelope[]): void => {
  const nextModel = findClaudeModelChangeInEnvelopes(envelopes);
  if (!nextModel) return;
  void sessionMetadataUpdater.updateModel(nextModel).catch((error) => {
    logger.warn("[start-claude] failed to persist live model change", {
      model: nextModel,
      error: error instanceof Error ? error.message : String(error),
    });
  });
};
```

`findClaudeModelChangeInEnvelopes` (`modelChange.ts:40-52`) scans already-mapped envelopes,
extracts a clean model name via `normalizeTranscriptText`/`cleanModelLabel`
(`modelChange.ts:8-30`, which does strip ANSI and unwrap markdown/quote wrapping) — **but
only to feed the model chip** (`sessionMetadataUpdater.updateModel`). The cleaned string is
discarded after that; it is never written back into the envelope's own `md` field.

The actual envelope the web renders is built by `envelopeMapper.ts` straight from the raw
transcript block, unsanitized:

```ts
// envelopeMapper.ts:619-628 (assistant text block)
if (block.type === "text" && typeof (block as RawTextBlock).text === "string") {
  envelopes.push(
    createEnvelope(
      "agent",
      { t: "text", md: (block as RawTextBlock).text as string },
      { turn: turnId, subagent },
    ),
  );
  continue;
}
```

```ts
// envelopeMapper.ts:715-734 ("user" message type, non-sidechain, no tool result)
if (typeof content === "string") {
  if (isSidechainMessage(message)) {
    ...
  } else {
    closeTurn(state, "completed", envelopes);
    envelopes.push(createEnvelope("user", { t: "text", md: content }));
  }
  return envelopes;
}
```

Claude Code records a local slash command like `/model` in its JSONL transcript as a
synthetic **`user`**-type record whose content is a plain string wrapped in its own
XML-ish tags — the invocation as something like
`<command-message>model</command-message><command-name>/model</command-name>`, and the
*result* as a subsequent synthetic `user` record wrapped in
`<local-command-stdout>Set model to Haiku 4.5 and saved as your default for new
sessions.</local-command-stdout>`. There is no handling anywhere in `envelopeMapper.ts` for
either of these wrappers — a repo-wide search for `local-command`/`command-name`/
`command-stdout` inside `packages/cli/src` returns nothing. The only existing "synthetic
message" special-case is `isMetaMessage` (`envelopeMapper.ts:215-216`, `types.ts:19`'s
`isMeta` flag), which is a *different* Claude Code mechanism (SDK-injected prompts) and does
not cover local-command records at all. So the raw content — literal `<command-name>`/
`<local-command-stdout>` tags included — flows straight through `pickMessageContent` into a
plain `t: "text"` envelope and is rendered by the web's Streamdown-based
`MessageResponse` (`packages/web/src/components/ai-elements/message.tsx:326-340`) exactly
as authored, with no tag-stripping step anywhere in that pipeline.

### Proposed fix

Give local-command transcript records the same treatment `envelopeMapper.ts` already gives
the `/clear`/compact-boundary case (`isCompactSummaryMessage` → a quiet `service` marker,
`envelopeMapper.ts:604-613`) rather than a full chat bubble, and reuse `modelChange.ts`'s
existing ANSI-stripping (`normalizeTranscriptText`) instead of discarding it:

```ts
// envelopeMapper.ts — new helper, alongside isCompactSummaryMessage
const LOCAL_COMMAND_STDOUT_PATTERN = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;
const LOCAL_COMMAND_INVOCATION_PATTERN = /<command-name>([\s\S]*?)<\/command-name>/;

function extractLocalCommandStdout(content: string): string | null {
  const match = content.match(LOCAL_COMMAND_STDOUT_PATTERN);
  return match ? match[1]!.trim() : null;
}

function isLocalCommandInvocation(content: string): boolean {
  return LOCAL_COMMAND_INVOCATION_PATTERN.test(content);
}
```

```ts
// envelopeMapper.ts:715-734 — inside the `message.type === "user"`, string-content branch,
// before the existing isSidechainMessage check
if (typeof content === "string") {
  const stdout = extractLocalCommandStdout(content);
  if (stdout !== null) {
    // A local slash command's result (e.g. /model) — never a real chat
    // turn; surface it as a quiet service marker with ANSI/wrapping
    // stripped, reusing modelChange.ts's own cleaner (bug-fix-plan.md #4).
    envelopes.push(
      createEnvelope("agent", { t: "service", text: normalizeTranscriptText(stdout) }),
    );
    return envelopes;
  }
  if (isLocalCommandInvocation(content)) {
    // The invocation record itself (e.g. "/model haiku") carries no useful
    // information beyond what its stdout result already reports — drop it
    // rather than showing the raw XML wrapper as a user chat bubble.
    return envelopes;
  }
  if (isSidechainMessage(message)) {
    ...
```

`normalizeTranscriptText` needs to be exported from `modelChange.ts` (it's currently a
private helper) so `envelopeMapper.ts` can reuse it instead of duplicating ANSI-stripping
logic:

```ts
// modelChange.ts:8 — change `function normalizeTranscriptText` to `export function normalizeTranscriptText`
```

This keeps `findClaudeModelChangeInEnvelopes`'s model-chip side channel working unchanged
(it still scans the resulting envelopes — now the *cleaned* `service` text — for the "Set
model to X" pattern), while fixing what's actually shown in chat.

### Testing notes

- Add fixtures to `packages/cli/src/claude/__fixtures__/` (or a new
  `model-change-session.jsonl`) captured from a real `/model haiku` invocation in a live
  `tmux` session, covering both the invocation record and the `<local-command-stdout>`
  result record, and assert `mapClaudeToEnvelopes` produces a single clean `service`
  envelope with no XML tags and no ANSI codes.
- Extend `packages/cli/src/claude/modelChange.test.ts` (or a new
  `envelopeMapper.localCommand.test.ts`) with the exact strings from the live repro.
- Manual repro: run `falcon claude`, type `/model haiku`, confirm the web timeline shows a
  clean "Set model to Haiku 4.5..." service line with no visible tags or escape codes, and
  that the model chip in `ComposerControls` still updates.

---

## 5. Local permission-mode changes don't sync to the web mode chip

### Problem

Changing the permission mode locally (Shift+Tab in the live TUI, cycling
default → acceptEdits → plan → bypassPermissions) is not reflected in the web UI's mode
chip. The chip only updates when the mode change originates from the web itself.

### Root cause

The web derives the displayed permission mode from `deriveCurrentPermissionMode`
(`packages/web/src/features/session-control/session-state.ts:91-103`), which only inspects
two sources: a `mode-switch` render item (which resets to `"default"` — that's the
local↔remote *control* handoff, not a permission mode) and a `perm-placeholder`/`tool`
item's `permission.decision.kind === "mode"` — i.e., only decisions the *web itself* made
via a PermCard "Approve & switch mode" answer:

```ts
// session-state.ts:91-103
export function deriveCurrentPermissionMode(items: RenderItem[]): PermissionMode {
  let mode: PermissionMode = "default";
  for (const item of items) {
    if (item.kind === "mode-switch") {
      mode = "default";
    } else if (item.kind === "perm-placeholder" && item.permission.decision?.kind === "mode") {
      mode = item.permission.decision.mode;
    } else if (item.kind === "tool" && item.permission?.decision?.kind === "mode") {
      mode = item.permission.decision.mode;
    }
  }
  return mode;
}
```

There is no wire event at all for "the live TUI's permission mode is now X" as a standalone
fact — `packages/wire/src/session.ts:71-75`'s `mode-switch` event only carries `control:
"local"|"remote"`, never a `PermissionMode` value (confirmed: `PermissionModeSchema` is
used elsewhere in `packages/wire/src/rpc.ts` for the `setMode` RPC and inside
`PermDecisionSchema`, but nowhere in `session.ts`'s `SessionEventSchema` union).

Meanwhile, the CLI-side hook bridge *does* observe every local mode change — Claude Code's
own hooks report the live TUI's current mode on **every** `PreToolUse`/`PermissionRequest`
call — but only caches it internally for its own verification purposes, never emits
anything:

```ts
// pretoolPermissionBridge.ts:470-476
private cachePermissionMode(raw: string | undefined): void {
  if (raw === undefined) return;
  const mode = PERMISSION_MODE_CYCLE.find((m) => m === raw);
  if (!mode) return;
  this.lastPermissionMode = mode;
  for (const watcher of [...this.modeWatchers]) watcher(mode);
}
```

`modeWatchers` (`pretoolPermissionBridge.ts:452`) is only ever subscribed to by
`waitForModeEcho` (`pretoolPermissionBridge.ts:487-505`) — the mechanism that verifies a
**web-initiated** `setMode` RPC's Shift+Tab keystroke actually landed. Nothing calls
`this.deps.emitEnvelope(...)` from `cachePermissionMode`, so a **local** Shift+Tab press
(with no pending permission request in flight to attach a decision to) is entirely
invisible on the wire.

### Proposed fix

Add a new provider-agnostic wire event for "the permission mode is now X," and emit it from
`cachePermissionMode` whenever it observes a genuine change (not just an echo of the
already-known value):

```ts
// packages/wire/src/session.ts:71-75 — new variant alongside mode-switch
z.object({
  t: z.literal("permission-mode"),
  mode: PermissionModeSchema,
  source: z.enum(["terminal", "client"]),
}),
```

```ts
// pretoolPermissionBridge.ts:470-476 — cachePermissionMode, emit on real change only
private cachePermissionMode(raw: string | undefined): void {
  if (raw === undefined) return;
  const mode = PERMISSION_MODE_CYCLE.find((m) => m === raw);
  if (!mode) return;
  if (mode !== this.lastPermissionMode) {
    this.deps.emitEnvelope(
      createEnvelope("agent", { t: "permission-mode", mode, source: "terminal" }),
    );
  }
  this.lastPermissionMode = mode;
  for (const watcher of [...this.modeWatchers]) watcher(mode);
}
```

`emitEnvelope` is already a required dep on `PreToolPermissionBridge`
(`pretoolPermissionBridge.ts:325`, wired at `start.ts:724` as
`emitEnvelope: (envelope) => outbox.enqueue([envelope])`), so no new plumbing is needed at
the construction site.

On the reducer side, add a matching `RenderItem` kind (mirroring `mode-switch`'s existing
handling):

```ts
// packages/web/src/sync/reducer/types.ts — new item type alongside ModeSwitchItem
export interface PermissionModeItem extends RenderItemBase {
  kind: "permission-mode";
  mode: PermissionMode;
  source: "terminal" | "client";
}
```

```ts
// packages/web/src/sync/reducer/reduce.ts:124-126 — new case alongside "mode-switch"
case "permission-mode":
  items.push({ ...base, kind: "permission-mode", mode: ev.mode, source: ev.source });
  break;
```

```ts
// session-state.ts:91-103 — deriveCurrentPermissionMode, add the new case
export function deriveCurrentPermissionMode(items: RenderItem[]): PermissionMode {
  let mode: PermissionMode = "default";
  for (const item of items) {
    if (item.kind === "mode-switch") {
      mode = "default";
    } else if (item.kind === "permission-mode") {
      mode = item.mode;
    } else if (item.kind === "perm-placeholder" && item.permission.decision?.kind === "mode") {
      mode = item.permission.decision.mode;
    } else if (item.kind === "tool" && item.permission?.decision?.kind === "mode") {
      mode = item.permission.decision.mode;
    }
  }
  return mode;
}
```

The existing `perm-placeholder`/`tool`-decision cases stay (a web-initiated mode switch
still needs to reflect immediately, before the hook echo round-trips back), so both sources
now converge correctly; `permission-mode` events additionally give Home/any other consumer a
direct, single source of truth without hunting through permission decisions at all.

### Testing notes

- Add `pretoolPermissionBridge.test.ts` coverage: feed two hook calls with different
  `permission_mode` values and assert `emitEnvelope` is called exactly once, with the new
  `permission-mode` event, on the *second* call (the actual change), not the first
  (establishing the baseline) if `lastPermissionMode` starts `null` — decide and test
  whether the very first observed mode should also emit (announcing the session's starting
  mode) or only genuine transitions.
- Extend `session-state.test.ts` with a case asserting a `permission-mode` item with
  `source: "terminal"` updates `deriveCurrentPermissionMode` independent of any
  `perm-placeholder`/`tool` decision.
- Manual repro: run `falcon claude`, press Shift+Tab at the terminal to cycle to
  `acceptEdits`, confirm the web `ComposerControls` mode chip updates within one tool-call
  hook round-trip (no user action needed on the web side).

---

## 6. ExitPlanMode has no dedicated review card — falls to raw JSON

### Problem

When Claude Code calls `ExitPlanMode` (presenting a plan for approval), the web timeline
shows the generic MCP/unknown-tool fallback card — raw JSON dump of `args`/`output` — instead
of a readable rendering of the plan text.

### Root cause

`packages/web/src/components/timeline/tool-cards/registry.tsx:23-39`'s `REGISTRY` has no
entry for `ExitPlanMode`/`exit_plan_mode`:

```ts
const REGISTRY: Record<string, (item: ToolItem) => ReactElement> = {
  Bash: (item) => <BashCard item={item} />,
  Edit: (item) => <EditCard item={item} />,
  MultiEdit: (item) => <EditCard item={item} />,
  Write: (item) => <EditCard item={item} />,
  Read: (item) => <ReadCard item={item} />,
  Grep: (item) => <GrepGlobCard item={item} />,
  Glob: (item) => <GrepGlobCard item={item} />,
  LS: (item) => <LsCard item={item} />,
  TodoWrite: (item) => <TodoCard item={item} />,
  Task: (item) => <TaskCard item={item} />,
  AskUserQuestion: (item) => <AskUserQuestionToolCard item={item} />,
  ask_user_question: (item) => <AskUserQuestionToolCard item={item} />,
  WebFetch: (item) => <WebFetchCard item={item} />,
  WebSearch: (item) => <WebSearchCard item={item} />,
  NotebookEdit: (item) => <NotebookEditCard item={item} />,
};

export function ToolCard({ item }: { item: ToolItem }) {
  if (item.name.startsWith("mcp__")) {
    return <McpGenericCard item={item} />;
  }
  const render = REGISTRY[item.name];
  return render ? render(item) : <McpGenericCard item={item} />;
}
```

Any tool name that isn't in `REGISTRY` (and isn't `mcp__*`) falls through to
`McpGenericCard` (`packages/web/src/components/timeline/tool-cards/McpGenericCard.tsx:9-17`),
which explicitly dumps raw `args`/`output` via `JsonBlock` — this is by design *for truly
unknown tools*, but `ExitPlanMode` is a well-known, first-class Claude Code tool whose
`args` shape is already used elsewhere in this same codebase's own tests
(`session-state.test.ts:37-45`, `:57-65`): `{ plan: string }` (markdown plan text).

### Proposed fix

Add a dedicated card following the exact pattern `TaskCard`/`TodoCard` already establish
(defensive arg-parsing via `lib/tool-args.ts` helpers + `ToolCardShell` for the common
chrome), rendering the plan body through the existing markdown pipeline instead of raw JSON:

```ts
// packages/web/src/lib/tool-args.ts — new parser alongside parseTodoItems etc.
export interface ExitPlanModeArgs {
  plan?: string;
}

export function parseExitPlanModeArgs(args: unknown): ExitPlanModeArgs {
  const r = asRecord(args);
  return { plan: readString(r, "plan") };
}
```

```tsx
// packages/web/src/components/timeline/tool-cards/ExitPlanModeToolCard.tsx — new file
import { ClipboardList } from "lucide-react";
import { parseExitPlanModeArgs } from "@/lib/tool-args";
import type { ToolItem } from "@/sync/reducer";
import { Markdown } from "../Markdown";
import { ToolCardShell } from "./ToolCardShell";

/** `ExitPlanMode` presents a plan for approval — render its markdown body
 * nicely instead of falling to the generic JSON fallback (bug-fix-plan.md #6). */
export function ExitPlanModeToolCard({ item }: { item: ToolItem }) {
  const { plan } = parseExitPlanModeArgs(item.args);

  return (
    <ToolCardShell item={item} icon={<ClipboardList className="size-4 text-muted-foreground" />}>
      {plan ? (
        <Markdown md={plan} />
      ) : (
        <p className="text-xs text-muted-foreground">No plan text recorded.</p>
      )}
    </ToolCardShell>
  );
}
```

```ts
// registry.tsx:23-39 — register both spellings, mirroring AskUserQuestion's pattern
import { ExitPlanModeToolCard } from "./ExitPlanModeToolCard";
// ...
const REGISTRY: Record<string, (item: ToolItem) => ReactElement> = {
  // ...existing entries...
  ExitPlanMode: (item) => <ExitPlanModeToolCard item={item} />,
  exit_plan_mode: (item) => <ExitPlanModeToolCard item={item} />,
};
```

`ToolCardShell` already renders the pending-decision `PermCard`/`AskUserQuestionCard`
action row generically (`ToolCardShell.tsx:87-104`) when `item.permission.decision` is
undefined, so the approve/deny UI for a plan under review needs no special-casing here —
this card only needs to supply the plan body, exactly like `TaskCard` only supplies its
description/prompt body.

### Testing notes

- Add `packages/web/src/components/timeline/tool-cards/ExitPlanModeToolCard.test.ts`
  (render-to-string, matching `ToolCardShell.test.ts`'s style) asserting the plan markdown
  renders and that a missing/malformed `plan` field falls back to the "No plan text
  recorded" message rather than crashing.
- Extend `registry.test.ts` to assert `ExitPlanMode`/`exit_plan_mode` resolve to the new
  card, not `McpGenericCard`.
- Manual repro: ask Claude Code to enter plan mode and call `ExitPlanMode`; confirm the web
  timeline shows readable plan text (headings/lists rendered, not raw JSON) with a working
  Allow/Deny action row while the decision is pending.

---

## 7. TaskCreate/TaskUpdate render as raw JSON

### Problem

Per the live E2E pass, tool calls named `TaskCreate`/`TaskUpdate` (reported as a newer
task-list mechanism alongside or replacing `TodoWrite`) render as raw JSON in the web
timeline.

### Root cause — honest scope note

`registry.tsx`'s `REGISTRY` (`packages/web/src/components/timeline/tool-cards/registry.tsx:23-39`)
has no `TaskCreate`/`TaskUpdate` entries — confirmed, alongside `TodoWrite` (which *is*
registered, mapping to `TodoCard`). Any call to `TaskCreate`/`TaskUpdate` therefore falls
through the same `render ? render(item) : <McpGenericCard item={item} />` path
(`registry.tsx:46-47`) as issue #6, landing on the raw-JSON fallback.

**I could not find any trace of these tool names' actual input/output schema anywhere in
this repository** — a repo-wide search for `TaskCreate`/`TaskUpdate`/`TaskView`/`TaskList`
across `packages/` returns zero results (no fixtures, no prior parsing code, no test data).
`lib/tool-args.ts`'s `parseTodoItems` (`tool-args.ts:155-165`) is built specifically against
`TodoWrite`'s known `{ todos: [{content, status, activeForm}] }` shape and doesn't
generalize to whatever `TaskCreate`/`TaskUpdate`'s real argument shape is. I am not
confident enough in the exact field names to write a parser against a schema I have not
verified — doing so risks fabricating an API that doesn't match the real tool. This section
proposes the registration + generic-but-safe rendering approach; **capturing a real
`TaskCreate`/`TaskUpdate` transcript entry from a live session should be the first step of
implementing this**, the same way `parseWebSearchResults`'s own doc comment
(`tool-args.ts:200-205`) explains it was written against "a real transcript,
`__fixtures__/task_non_sdk.jsonl`" rather than guessed.

### Proposed fix

1. Capture a live fixture: run a Claude Code session that triggers `TaskCreate`/`TaskUpdate`
   (e.g. a multi-step agentic task), and save its real transcript JSONL entries to
   `packages/cli/src/claude/__fixtures__/task-create-update-session.jsonl`, the same
   convention `__fixtures__/task_sdk.jsonl`/`task_non_sdk.jsonl` already follow.
2. Once the real args/output shape is known, add a defensive parser to `tool-args.ts`
   following the existing pattern exactly (never throw, degrade to `undefined` on shape
   mismatch — per this file's own header doc, `tool-args.ts:1-9`):

   ```ts
   // packages/web/src/lib/tool-args.ts — illustrative shape, verify field names
   // against the real captured fixture before finalizing
   export interface TaskEntryArgs {
     title?: string;
     description?: string;
     status?: string;
   }

   export function parseTaskEntryArgs(args: unknown): TaskEntryArgs {
     const r = asRecord(args);
     return {
       title: readString(r, "title"),
       description: readString(r, "description"),
       status: readString(r, "status"),
     };
   }
   ```

3. Add a card — most likely a close sibling of `TodoCard` (`TodoCard.tsx:7-45`) if
   `TaskCreate`/`TaskUpdate` really is "TodoWrite's replacement," rendering a checklist-style
   view — registered for both tool names:

   ```ts
   // registry.tsx:23-39
   TaskCreate: (item) => <TaskEntryCard item={item} />,
   TaskUpdate: (item) => <TaskEntryCard item={item} />,
   ```

Until the real shape is confirmed, do **not** ship a parser with guessed field names — a
wrong guess silently produces empty/misleading cards instead of the honest raw-JSON
fallback the design principle (`tool-args.ts:1-9`) explicitly calls for in exactly this
"shape mismatch" situation. Registering the tool names against a defensive parser that
degrades to a labeled-but-mostly-empty card would be *worse* than the current raw-JSON
fallback, which at least shows real data.

### Testing notes

- First: reproduce live and capture the fixture (see step 1 above) — this is a
  precondition for the rest of this task, not optional polish.
- Once the fixture exists, add `TaskEntryCard.test.ts` and a `registry.test.ts` case
  mirroring `ExitPlanModeToolCard`'s tests in #6.
- Manual repro: trigger a real `TaskCreate`/`TaskUpdate` call and confirm the web timeline
  shows a readable checklist/status view, not raw JSON.

---

## 8. Agent/subagent tool leaks internal metadata into visible chat

### Problem

Subagent activity shown in the timeline displays a meaningless internal identifier as if it
were user-facing information — e.g. "Subagent x8f3k2m9p1q7r2s..." — instead of a readable
label.

### Root cause

`packages/web/src/components/timeline/SubagentGroup.tsx:8-32` renders whatever `id` it's
given directly into visible chat text:

```tsx
// SubagentGroup.tsx:8-32
export function SubagentGroup({
  id,
  items,
  compact = false,
}: {
  id: string;
  items: RenderItem[];
  compact?: boolean;
}) {
  return (
    <div className={...}>
      <p className="mb-3 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <Users className="size-3.5" />
        Subagent {id}
      </p>
      <NestedItems items={items} />
    </div>
  );
}
```

The caller, `packages/web/src/components/timeline/RenderItemGroups.tsx:217-222`, passes the
render item's raw `subagentId`:

```tsx
<SubagentGroup
  key={group.id}
  id={group.item.subagentId}
  items={group.item.items}
  compact={compact}
/>
```

That `subagentId` is not a human-meaningful name — it's a locally-minted `cuid2` (via
`mintedId`/`createId()` in `packages/cli/src/claude/envelopeMapper.ts:143-157`, the CLI's
own internal bookkeeping id for a subagent scope that was never linked to a parent
`Task`-like tool call). It carries zero user-facing meaning; it exists purely so the reducer
can group envelopes belonging to the same orphaned subagent scope
(`packages/web/src/sync/reducer/reduce.ts:259-277`, `envelopesByScope` keyed by this exact
id). This is the "leaked internal metadata" the E2E pass flagged — an opaque provider/CLI
bookkeeping token rendered verbatim as chat copy.

Note that this label only exists for the *standalone/orphaned* subagent-group case — when a
subagent scope IS linked to a parent `Task` call, `ToolCardShell.tsx:105-109`'s
`NestedItems` rendering shows no id/label header at all, it renders directly inside the
already-labeled `Task` tool card. So the fix only needs to touch this one, narrower path.

### Proposed fix

Replace the raw internal id with a per-render, human-meaningful ordinal ("Subagent 1",
"Subagent 2", ...) computed at the point where standalone groups are enumerated, rather than
exposing the CLI's internal bookkeeping token at all:

```tsx
// SubagentGroup.tsx:8-16 — change the prop from a raw id to a display label
export function SubagentGroup({
  label,
  items,
  compact = false,
}: {
  label: string;
  items: RenderItem[];
  compact?: boolean;
}) {
  return (
    <div className={...}>
      <p className="mb-3 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <Users className="size-3.5" />
        {label}
      </p>
      <NestedItems items={items} />
    </div>
  );
}
```

```tsx
// RenderItemGroups.tsx:211-227 — compute an ordinal instead of forwarding subagentId
export function RenderItemGroups({ items, compact = false, emptyLabel = "No activity recorded." }: {
  items: RenderItem[];
  compact?: boolean;
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const groups = groupRenderItems(items);
  let subagentOrdinal = 0;

  return (
    <div className={cn("flex flex-col gap-5", compact && "gap-3")}>
      {groups.map((group) => {
        if (group.kind === "message") {
          return <MessageGroupView key={group.id} group={group} compact={compact} />;
        }
        subagentOrdinal += 1;
        return (
          <SubagentGroup
            key={group.id}
            label={`Subagent ${subagentOrdinal}`}
            items={group.item.items}
            compact={compact}
          />
        );
      })}
    </div>
  );
}
```

This removes the internal id from the render path entirely — `group.item.subagentId` is
still used as the React `key` (`group.id`, which already embeds it — `` `${item.id}:${item.kind}` ``
at `RenderItemGroups.tsx:87`) for stable reconciliation, it's just never shown as text.

### Testing notes

- Add/extend `packages/web/src/components/timeline/RenderItemGroups.test.ts` asserting that
  with two standalone subagent groups in the same `items` array, the rendered output
  contains "Subagent 1" and "Subagent 2" and does **not** contain any cuid-shaped substring
  from the underlying `RenderItem`s' `subagentId`.
- Manual repro: trigger a subagent scope that never links to a parent `Task` call (or
  inspect an existing transcript with orphaned sidechain content) and confirm the web
  timeline shows "Subagent 1"/"Subagent 2" rather than a random-looking token.

---

## 9. Silent JWT expiry — no warning shown

### Problem

When the web app's stored JWT expires, nothing tells the user — no banner, no redirect
prompt, nothing. The app just quietly stops working.

### Root cause

`packages/web/src/lib/session.ts` treats "has a token string in `localStorage`" as
equivalent to "is signed in," with no inspection of the JWT's own claims at all:

```ts
// session.ts:18-35
export function getToken(): string | null {
  if (!hasLocalStorage()) return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (!hasLocalStorage()) return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (!hasLocalStorage()) return;
  window.localStorage.removeItem(TOKEN_KEY);
}

export function isSignedIn(): boolean {
  return getToken() !== null;
}
```

There is no `exp`-claim decode/comparison anywhere in this file (or, per the search done for
this report, anywhere else in `packages/web/src`). The design doc's own stated JWT lifetime
is "1 h, auto-refresh" (`session.ts:1-9`'s header comment cites this), but no refresh
mechanism and no proactive expiry check actually exist client-side — a token silently past
its `exp` looks identical to a fresh one from `isSignedIn()`'s perspective, right up until
the *server* rejects it (see issue #10, which is the visible symptom of this same gap).

### Proposed fix

Add a lightweight, dependency-free JWT expiry check (base64url-decode the payload segment,
read `exp`, compare to now — no signature verification needed client-side, this is purely a
UX freshness check, not a security boundary):

```ts
// session.ts — new helper
function decodeJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadJson = atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"));
    const payload: unknown = JSON.parse(payloadJson);
    const exp = (payload as { exp?: unknown })?.exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

/** True once the stored token's own `exp` claim has passed (or is unparsable —
 * treated as expired rather than silently trusted, per this codebase's "no
 * silent failures" principle). `null`/no-token also returns `true` (nothing
 * valid to trust). */
export function isTokenExpired(): boolean {
  const token = getToken();
  if (!token) return true;
  const exp = decodeJwtExp(token);
  if (exp === null) return true;
  return Date.now() >= exp * 1000;
}

export function isSignedIn(): boolean {
  return getToken() !== null && !isTokenExpired();
}
```

Then surface it proactively, not just at the moment of use — e.g. a periodic check (every
minute or so) in the same place `OfflineBanner`/`useConnectivity` already live
(`packages/web/src/lib/use-connectivity.ts`), or a dedicated `useTokenExpiry()` hook that
redirects to `/signin/` with an explanatory message once `isTokenExpired()` flips true,
rather than waiting for a socket reconnect to fail (see #10, which should share this same
signal).

### Testing notes

- Add `packages/web/src/lib/__tests__/session.test.ts` cases: a token with a far-future
  `exp` → `isSignedIn() === true`; a token with a past `exp` → `false`; a malformed token
  (not 3 dot-separated segments, or non-JSON payload) → treated as expired, not thrown.
- Manual repro: manually set an expired JWT into `localStorage["falcon:token"]`, reload the
  app, confirm a "please sign in again" state appears proactively rather than the app
  silently failing to sync.

---

## 10. Permanently stuck "Reconnecting…" after a page reload with an expired token

### Problem

Reloading the page with an expired token leaves the UI stuck on "Reconnecting to Falcon…"
forever, with no way out except manually clearing storage/signing out.

### Root cause

Three pieces combine into a genuine dead end:

1. **The server rejects an expired/invalid token at the socket handshake**, in middleware,
   before `connection` fires — `packages/server/src/app/socket.ts:54-84`:

   ```ts
   io.use(async (socket, next) => {
     const token = socket.handshake.auth.token as string | undefined;
     ...
     if (!token) {
       next(new Error("Missing authentication token"));
       return;
     }
     ...
     const verified = await verifyToken(token);
     if (!verified) {
       app.log.warn({ module: "websocket" }, "socket connect rejected: invalid token");
       next(new Error("Invalid authentication token"));
       return;
     }
     ...
   });
   ```

   Calling `next(new Error(...))` in Socket.IO middleware causes the *client* to receive a
   `connect_error` event, not a normal `disconnect`.

2. **`apiSocket.ts` never listens for `connect_error` at all.** Its full event wiring is:

   ```ts
   // apiSocket.ts:234-238
   nextSocket.on("connect", handleConnect);
   nextSocket.on("disconnect", handleDisconnect);
   nextSocket.on("update", handleUpdate);
   nextSocket.on("ephemeral", handleEphemeral);
   ```

   No `connect_error` handler exists anywhere in this file. So an auth-rejected reconnect
   attempt is completely invisible to the app — it looks identical (from the app's
   perspective) to "still trying to reconnect," because nothing distinguishes "the transport
   failed to reach the server" from "the server actively rejected my credentials."

3. **Socket.IO is configured to retry forever, with the same doomed token every time** —
   `packages/web/src/sync/socket-factory.ts:32-43`:

   ```ts
   reconnection: true,
   reconnectionAttempts: Number.POSITIVE_INFINITY, // infinite reconnect — plan.md 1.6 / design §9.1
   reconnectionDelay: 1_000,
   reconnectionDelayMax: 30_000,
   randomizationFactor: 0.5,
   timeout: 20_000,
   auth: (cb: (data: ApiSocketAuth) => void) => cb(getAuth()),
   ```

   `getAuth()` re-reads whatever `apiSocket.ts`'s closure-captured `token` currently is —
   which is whatever was passed to `connect(token)` at mount, i.e. the same expired token
   from `localStorage`, forever, since nothing ever calls `connect()` again with a fresh one.

The visible banner, `packages/web/src/components/OfflineBanner.tsx:24-41`, is driven by
`useConnectivity` (`packages/web/src/lib/use-connectivity.ts:40-67`), which only tracks
`connect`/`disconnect` — again, no `connect_error` — so it renders the generic, "this will
resolve itself" copy:

```tsx
// OfflineBanner.tsx:29-31
const message = !online
  ? "You're offline. Changes will sync once your connection returns."
  : "Reconnecting to Falcon…";
```

There is no code path anywhere that turns "the server told us the token is invalid" into
"tell the user to sign in again." The infinite-retry engine keeps retrying the same rejected
handshake indefinitely, and the UI keeps showing the transient-sounding "Reconnecting…"
message for what is actually a permanent, un-fixable-by-waiting condition.

### Proposed fix

Wire up `connect_error` in `apiSocket.ts` as a first-class event, and use it (together with
issue #9's `isTokenExpired()`) to break out of the infinite-retry illusion:

```ts
// apiSocket.ts:72-82 — add to the event map
type ApiSocketEventMap = {
  update: Update;
  ephemeral: Ephemeral;
  reconnect: undefined;
  connect: undefined;
  disconnect: undefined;
  /** Fires when a (re)connection attempt is rejected by the server (e.g. an
   * expired/invalid token) — distinct from a transport-level disconnect,
   * which infinite-retry can genuinely recover from on its own
   * (bug-fix-plan.md #10). */
  authError: { message: string };
};
```

```ts
// apiSocket.ts:229-238 — subscribe to Socket.IO's connect_error, translate auth
// failures into the new authError event
const handleConnectError = (err: Error): void => {
  // Socket.IO delivers the middleware's `next(new Error(...))` message verbatim.
  if (/authentication token/i.test(err.message)) {
    emit("authError", { message: err.message });
  }
};
// ...
nextSocket.on("connect", handleConnect);
nextSocket.on("disconnect", handleDisconnect);
nextSocket.on("connect_error", handleConnectError);
nextSocket.on("update", handleUpdate);
nextSocket.on("ephemeral", handleEphemeral);
```

(and unsubscribe it in `teardown()` alongside the other `.off(...)` calls at
`apiSocket.ts:202-215`).

Then have `useConnectivity` (or a new small hook next to it) listen for `authError` and stop
presenting it as "Reconnecting…":

```ts
// use-connectivity.ts — extend ConnectivitySource + state
export interface ConnectivitySource {
  isConnected(): boolean;
  on(event: "connect" | "disconnect" | "authError", handler: (payload?: unknown) => void): () => void;
}

export interface ConnectivityState {
  online: boolean;
  wsConnected: boolean;
  authExpired: boolean;
}
```

```tsx
// OfflineBanner.tsx — branch on authExpired before the generic reconnecting copy
const { online, wsConnected, authExpired } = useConnectivity();

if (authExpired) {
  return (
    <div role="status" className="...">
      Your session expired.{" "}
      <Link href="/signin/" className="underline">Sign in again</Link>.
    </div>
  );
}
if (online && wsConnected) return null;
```

Also stop the doomed retry loop itself once `authError` fires — call `apiSocket.disconnect()`
rather than letting Socket.IO keep retrying a handshake that cannot succeed without a fresh
token, since `reconnectionAttempts: Infinity` has no way to know the failure is permanent on
its own.

### Testing notes

- Add `packages/web/src/sync/__tests__/apiSocket.test.ts` coverage: a fake `SocketLike` that
  emits `connect_error` with `new Error("Invalid authentication token")`, and assert
  `apiSocket` emits `authError` with that message.
- Add `use-connectivity.test.ts` coverage for the new `authExpired` state.
- Manual repro: set an expired token, reload, confirm the banner switches to "Sign in
  again" within one retry cycle instead of showing "Reconnecting…" forever, and that
  clicking through actually reaches `/signin/`.

---

## 11. `falcon auth login` leaks abort listeners

### Problem

Running `falcon auth login` produces `MaxListenersExceededWarning: Possible EventTarget
memory leak detected. 11 abort listeners added to [AbortSignal]` after the process has been
polling for approval for a while.

### Root cause

`packages/cli/src/auth/pair.ts:111-123`'s `delay` helper adds a fresh `abort` listener to
the **same, long-lived, shared** `AbortSignal` on every call, and only removes that listener
when *that specific call* is the one that gets aborted:

```ts
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
```

`{ once: true }` only removes the listener when the `abort` event actually *fires* — it does
nothing when the promise instead resolves via the **timer** path (the normal, non-aborted
case, which is every poll tick except possibly the very last one). `pairDevice`'s polling
loop (`pair.ts:147-168`) calls `delay(pollIntervalMs, signal)` once per 2-second tick
(`pair.ts:151`), passing the *same* `AbortController`'s `signal` every time — the one
`runAuthLogin` creates once for the whole login attempt (`login.ts:41-43`,
`const controller = new AbortController();`). Over a pairing wait that can last up to the
full 15-minute `PAIRING_TIMEOUT_MS` (`pair.ts:35`), that's up to ~450 poll ticks, each
leaving behind a dangling `abort` listener that never fires and never gets cleaned up — 11
of them is enough to cross Node's default `AbortSignal` max-listener threshold (10) and
trigger the warning, well before the timeout is reached.

Notably, `packages/cli/src/claude/scanner.ts:209-224` has the *correct* version of this
exact same pattern already in the codebase, one file away in spirit — its own `wait()`
helper removes the abort listener in **both** branches:

```ts
// scanner.ts:209-224 (for reference — the correct pattern)
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (abortController.signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      abortController.signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    abortController.signal.addEventListener("abort", onAbort, { once: true });
  });
```

### Proposed fix

Apply the same fix to `pair.ts`'s `delay`, removing the listener on the timer path too:

```ts
// pair.ts:111-123
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
```

(Matches `scanner.ts`'s `wait()` exactly in structure — declare `onAbort` first so the timer
callback can reference it, since `const timer` isn't in scope yet at the point `onAbort`
needs to call `clearTimeout(timer)`; both are fine in practice since neither is invoked
synchronously during construction.)

### Testing notes

- Add a unit test to a new/extended `packages/cli/src/auth/pair.test.ts`: create a real
  `AbortController`, call `delay(10, controller.signal)` in a loop 20 times (letting each
  resolve via its timer, never aborting), then assert
  `controller.signal.listenerCount ? controller.signal.listenerCount("abort") : ...`— or,
  simpler, spy on `AbortSignal.prototype.addEventListener`/`removeEventListener` call counts
  and assert they're equal after the loop (every add has a matching remove).
- Manual repro: run `falcon auth login`, do not approve it, watch the CLI's stderr/log
  output for 30+ seconds (15+ poll ticks) and confirm no `MaxListenersExceededWarning`
  appears (previously reproducible around the 11th tick, ~22s in).

---

## 12. No recovery path if the browser's local identity is lost

### Problem

If a browser's local crypto identity (IndexedDB-held key material) is lost — cleared
storage, new browser, wiped profile — there is no way to get back to the original account.
The sign-in flow instead silently provisions a brand-new, disconnected account, orphaning
all of the user's prior sessions/data.

### Root cause

Confirmed end-to-end across the client and server:

**1. The pairing page redirects to sign-in without checking for a recoverable identity
   beyond localStorage.** `packages/web/src/app/(public)/pair/page.tsx:56-60`:

```tsx
if (!identity || !isSignedIn()) {
  stashPendingPair(ephPub);
  router.replace("/signin/");
  return;
}
```

**2. `isSignedIn`/`getToken` only ever check `localStorage`,** not whether the crypto
worker's IndexedDB-held identity exists — `packages/web/src/lib/session.ts:18-35` (quoted in
full in issue #9 above). A cleared IndexedDB with a still-valid token in `localStorage` (or
vice versa) is not specifically handled either way here; the two storages are independent
and neither check considers the other.

**3. `signin/page.tsx` falls straight into `needs-signup` with no recovery option** once
`bridge.getIdentity()` resolves `null` — `packages/web/src/app/(public)/signin/page.tsx:43-50`:

```tsx
(async () => {
  const identity = await bridge.getIdentity();
  if (cancelled) return;

  if (!identity) {
    setStatus({ kind: "needs-signup" });
    return;
  }
  ...
```

The `needs-signup` render branch (`signin/page.tsx:183-244`) offers only "Continue with
Google"/"Continue with GitHub" (and a dev-only bypass) — no recovery-code entry point at
all.

**4. Continuing with OAuth from `needs-signup` always mints a brand-new identity** —
`packages/web/src/lib/complete-oauth-sign-in.ts:38-47`:

```ts
let identity = await bridge.getIdentity();
let recoveryCode: string | null = null;

if (!identity) {
  await ready;
  const masterSecret = getRandomBytes(32);
  await bridge.init(masterSecret);
  recoveryCode = await bridge.exportRecoveryCode();
  identity = await bridge.getIdentity();
}
```

Since `getIdentity()` is null (that's the whole reason this path was reached), this
*always* generates a fresh random `masterSecret` — there is no attempt to recover the
original one first.

**5. The server's upsert can't help, because it has no way to know these are the same
   person.** `packages/server/src/app/routes/oauth.ts:150-166`:

```ts
const [account] = await db
  .insert(accounts)
  .values({
    signPublicKey: signPublicKeyHex,
    contentPubKey,
    oauthProvider: identity.provider,
    oauthSubject: identity.subject,
  })
  .onConflictDoUpdate({
    target: accounts.signPublicKey,
    set: { contentPubKey, oauthProvider: identity.provider, oauthSubject: identity.subject },
  })
  .returning();
```

The upsert's conflict target is `accounts.signPublicKey` — and per
`packages/server/src/db/schema.ts:25-30`, that's the *only* unique index on the table:

```ts
export const accounts = pgTable("accounts", {
  ...
  signPublicKey: text("sign_public_key").notNull().unique(), // hex; identity anchor
  ...
  oauthProvider: text("oauth_provider"), // recovery binding
  oauthSubject: text("oauth_subject"),
  ...
```

`oauthProvider`/`oauthSubject` are plain columns with no unique constraint. Since step 4
always mints a brand-new random `signPublicKey`, it can never collide with the original
account's row — even though the *same* Google/GitHub identity (`oauthSubject`) was already
bound to a previous account, the upsert has no way to detect that and always inserts a new,
disconnected row instead of recognizing "this is the same person, on a new device that lost
its keys."

**The good news:** the actual cryptographic building block for recovery already exists,
fully implemented and fuzz-tested, and is simply never called from the web app.
`packages/crypto/src/recovery.ts` exports `decodeRecoveryCode` (the inverse of
`encodeRecoveryCode`, which `complete-oauth-sign-in.ts:45`/`worker-handler.ts:170-186`
already use to *export* a recovery code) — verified via
`packages/crypto/src/__tests__/recovery.test.ts` and `edge-cases.test.ts` (round-trip,
typo-tolerance, and fuzz coverage). A repo-wide search confirms **zero** references to
`decodeRecoveryCode` anywhere under `packages/web/src` — the primitive is there, only the
UI wiring to use it is missing. Similarly, `(protected)/settings/recovery/page.tsx` only
*exports* an existing device's code (`reveal()` → `bridge.exportRecoveryCode()`,
`recovery/page.tsx:33-38`) — there is no *import*/redeem flow anywhere in the app, so the
"wire the needs-signup state to the existing recovery-code flow" framing needs one
correction: that redemption flow does not exist yet either and needs to be built, using the
already-present `decodeRecoveryCode` primitive.

### Proposed fix

Add a "Restore from recovery code" entry point to `signin/page.tsx`'s `needs-signup` state,
*before* offering fresh OAuth sign-up, using the existing (already-tested)
`decodeRecoveryCode` + `bridge.init` + the existing returning-device challenge-sign-in path
— no server changes required, since `/v1/auth`'s challenge-response route already looks up
an account by its (now-restored) `signPublicKey`:

```tsx
// signin/page.tsx — new status branch
type Status =
  | { kind: "checking" }
  | { kind: "signing-in" }
  | { kind: "needs-signup" }
  | { kind: "restoring" }
  | { kind: "error"; message: string };
```

```tsx
// signin/page.tsx — new handler, alongside the existing effect
async function restoreFromRecoveryCode(bridge: CryptoBridgeClient, code: string) {
  setStatus({ kind: "restoring" });
  const masterSecret = decodeRecoveryCode(code);
  if (!masterSecret) {
    setStatus({ kind: "error", message: "That recovery code doesn't look right. Check it and try again." });
    return;
  }
  await bridge.init(masterSecret);
  try {
    const { nextUrl } = await completeChallengeSignIn(bridge);
    router.replace(nextUrl);
  } catch (err) {
    // No account exists for this identity — a wrong-but-well-formed code, or
    // one for an account that was deleted server-side.
    const message = err instanceof ApiError
      ? "No account found for that recovery code."
      : "Restore failed. Please retry.";
    setStatus({ kind: "error", message });
  }
}
```

```tsx
// signin/page.tsx:183-244 — inside the needs-signup branch, above the OAuth buttons
{status.kind === "needs-signup" && (
  <>
    <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-4">
      <p className="text-sm font-medium">Already have a Falcon account?</p>
      <p className="text-sm text-muted-foreground">
        If this is a new or wiped browser, restore your existing identity with your
        recovery code instead of creating a new account.
      </p>
      <RecoveryCodeInput onSubmit={(code) => restoreFromRecoveryCode(bridge, code)} />
    </div>
    <div className="relative">
      <Separator />
      <span className="...">Or provision this browser</span>
    </div>
    {/* existing "Continue with Google"/"Continue with GitHub" buttons unchanged */}
  </>
)}
```

`RecoveryCodeInput` is a small new component (a text input + submit button, following
`RecoveryCodeCard`'s existing styling conventions in
`packages/web/src/components/auth/recovery-code-card.tsx`) — omitted here for brevity, but
straightforward: a controlled text field plus a button calling `onSubmit`.

This reuses `decodeRecoveryCode` (import from `@falcon/crypto/web`, matching this package's
existing import style for `getRandomBytes`/`ready` in `complete-oauth-sign-in.ts:23`),
`bridge.init` (same method the fresh-signup path already calls,
`complete-oauth-sign-in.ts:44`), and `completeChallengeSignIn` (the exact same
returning-device login path `signin/page.tsx:54` already uses) — no new crypto, no new
server route, no schema change. The account-collision problem in `oauth.ts`/`schema.ts`
(items 4-5 above) becomes moot for this flow entirely: restoring the *original*
`signPublicKey` via the recovery code means the existing `/v1/auth` challenge-response route
finds the *same* account row that already exists, rather than ever reaching the
OAuth-registration upsert at all.

### Testing notes

- Add a component test for the new `needs-signup` branch asserting the recovery-code input
  is present and calls `decodeRecoveryCode` + `bridge.init` + `completeChallengeSignIn` in
  order, with a fake `CryptoBridgeClient`.
- Add a case for a malformed code (`decodeRecoveryCode` returns `null`) showing the inline
  error without calling `bridge.init` at all.
- Manual repro (the real regression test): sign up fresh, reveal the recovery code from
  `/settings/recovery/`, then clear the browser's storage entirely (or use a private/second
  browser profile) and confirm entering that recovery code on `/signin/` restores the exact
  same account — same sessions, same title/data visible on Home — rather than landing on an
  empty "no sessions yet" screen for a new account.
- Also verify the negative case live: an invalid/garbage recovery code shows an inline error
  and does **not** create a new account as a side effect.

---

## 13. Sessions list flashes placeholder text on every load

### Problem

The Home/sessions list visibly flashes literal placeholder text — "(untitled session)" /
"(unnamed machine)" — before the real decrypted titles appear, on every page load (and
likely on every resync).

### Root cause

`packages/web/src/features/session-list/live-source.ts:82-83` defines the fallback
constants, and `buildSnapshot` (`live-source.ts:369-383`, `:354-358`) unconditionally
defaults to them via `??` whenever a title hasn't been decrypted yet:

```ts
// live-source.ts:369-383
const sessions: SessionListSession[] = sessionRows.map((s) => ({
  id: s.id,
  workspaceId: s.workspaceId,
  machineId: s.machineId,
  title: titles.sessions.get(s.id) ?? UNTITLED_SESSION,
  ...
}));
```

```ts
// live-source.ts:354-358
const machines: SessionListMachine[] = machineRows.map((m) => ({
  id: m.id,
  name: titles.machines.get(m.id) ?? UNNAMED_MACHINE,
  ...
}));
```

`titles` (the decrypted-title map) starts empty and is only populated by
`useDecryptedTitles`'s async effect (`live-source.ts:152-200`), which — by necessity, since
"a crypto-bridge worker only ever holds one active session key at once" (this file's own
header doc, `live-source.ts:39-50`) — decrypts every row's title **sequentially**, one
`setSessionKey` + `open` round-trip at a time (`live-source.ts:171-189`), not in parallel.
For any account with more than a couple of sessions, there is a real, visible window where
`sessionRows`/`machineRows` (the encrypted rows themselves) have already arrived from
`useSyncSnapshotQuery()`, but `titles` genuinely has no entry yet for most/all of them.

The screen-level loading guard only covers the *first* fetch of the encrypted rows
themselves, not per-row title decryption — `packages/web/src/features/session-list/session-list-screen.tsx:60-69`:

```tsx
if (snapshot.isLoading && groups.length === 0 && unmanagedSnapshot.sessions.length === 0) {
  return (
    <main ...>
      ...
      <SessionListSkeleton />
    </main>
  );
}
```

`query.isLoading` (from `useSyncSnapshotQuery()`) flips `false` as soon as the encrypted
`SessionRow[]`/`MachineRow[]` arrive — at that exact moment `groups.length > 0`, so this
whole-screen skeleton is skipped and the real `WorkspaceSection`/`SessionCard` list renders
immediately, even though `titles` is still empty. Each `SessionCard`
(`packages/web/src/features/session-list/components/session-card.tsx:36`,
`{session.title}`) then genuinely displays the literal `"(untitled session)"` string for
however long that row's position in the sequential decrypt queue takes to reach it — which
is not a rare race, it's the expected, designed-in behavior of this sequential decrypt
architecture on every single load.

There's already a purpose-built per-row skeleton for exactly this shape of problem —
`SessionCardSkeleton` in `packages/web/src/features/session-list/components/session-list-skeleton.tsx:9-23`
— but it's only ever used for the whole-list initial-load case, never per-row while an
individual title is still in flight.

### Proposed fix

Distinguish "not yet decrypted" from "decrypted successfully but empty/failed" so the two
can render differently — track presence in the titles map explicitly rather than defaulting
through `??` at read time, and use `undefined`/`null` (not the literal fallback text) as the
"not yet known" sentinel all the way out to the render layer:

```ts
// live-source.ts:369-383 — carry a nullable title through buildSnapshot instead
// of eagerly substituting the placeholder string
const sessions: SessionListSession[] = sessionRows.map((s) => ({
  id: s.id,
  workspaceId: s.workspaceId,
  machineId: s.machineId,
  title: titles.sessions.get(s.id) ?? null, // null = not decrypted yet (see SessionCard)
  ...
}));
```

```ts
// live-source.ts:108-124 — decryptSessionTitle already distinguishes "genuinely
// no title" from "not attempted yet" at the Map level once titles.sessions.has(id)
// is used instead of a fallback default — no change needed here, since a resolved
// decrypt (success OR failure) always sets an entry via `nextSessionTitles.set(...)`
// at live-source.ts:175; the gap is purely at the *read* side quoted above.
```

`SessionListSession.title`'s type changes from `string` to `string | null`
(`packages/web/src/features/session-list/types.ts`), and `SessionCard` renders a skeleton
in the null case instead of the fallback text:

```tsx
// session-card.tsx:36 — before
<CardTitle className="min-w-0 flex-1 truncate">{session.title}</CardTitle>

// after
<CardTitle className="min-w-0 flex-1 truncate">
  {session.title ?? <Skeleton className="h-4 w-32" />}
</CardTitle>
```

The literal `"(untitled session)"`/`"(unnamed machine)"` strings still exist and still
render — but now only once `useDecryptedTitles` has genuinely *finished* attempting that
row's decrypt and found no usable title (a real, meaningful "this session truly has no
title" state), never as a placeholder for "haven't gotten to it yet." The same treatment
applies symmetrically to `SessionListMachine.name` / `MachineBadge`.

### Testing notes

- Extend `packages/web/src/features/session-list/live-source.test.ts` (`buildSnapshot`'s
  existing direct-call test style, `live-source.test.ts:170-171`) with a case where
  `titles.sessions`/`titles.machines` are empty Maps and assert `session.title`/
  `machine.name` are `null`, not the placeholder strings — then a second case with the maps
  populated asserting the placeholder strings correctly appear only when the map entry
  itself is the empty-title sentinel value (i.e. decryption completed but yielded nothing).
- Add a `session-card.test.ts` (or extend an existing render test) asserting a `null` title
  renders a `Skeleton`, and a real string renders as text.
- Manual repro: load `/`, with dev tools' network throttled enough to make the sequential
  per-row decrypt visible, and confirm session cards show a shimmering placeholder block
  rather than literal "(untitled session)" text while their title is still being decrypted.

---

## Master TODO checklist (execution units)

Target branch: `v2-pty-injection` — every unit below lands there, matching plan-v2.md's own
Master TODO. Decision: rather than merging this checklist into plan-v2.md's own Master TODO
(which tracks an unrelated build-out track), a forked workflow —
`.claude/workflows/falcon-bugfix-workflow.js` (`falcon-bugfix-loop`) — reads *this* file's
checklist instead. It mirrors `falcon-dev-workflow.js` exactly (same phases, worktree/merge/
ancestry-proof mechanics, `[inline]`/`[bundle]`/`[solo]`/`[human]` semantics) with three
differences: it points at `docs/bug-fix-plan.md` instead of `plan-v2.md`, its unit-finder looks
for `BF*.*` checkboxes instead of `U*.*`, and its cycle bookkeeping writes to a separate
`docs/bug-fix-progress.md` instead of the repo's `progress.md` — so a bugfix cycle's
bookkeeping never collides with a `falcon-dev-loop` cycle's, even against the same branch.

The 13 issues above are restructured into **execution units** sized for that dev workflow, using
the same rationale plan-v2.md's own Master TODO states: running the full implement→test→
review→verify pipeline per tiny fix is mostly overhead, and several "small" fixes share files —
running those as parallel worktrees would manufacture merge conflicts. So units are grouped by
**file locality** (verified against each issue's own "Root cause" file citations above, not
assumed), not by theme. Unit IDs use the `BF` prefix (`BF1.1`, etc.) rather than plan-v2.md's `U`
prefix, so the two documents' units never collide if ever run side by side.

**Unit kinds** (same semantics as plan-v2.md, the workflow script reads these tags):

- `inline` — micro-tasks batched into ONE unit, executed by a single agent in one worktree
  (implement + test + self-review in a single pass). No parallel fan-out.
- `bundle` — co-located and/or tightly-coupled tasks; ONE worktree, ONE full pipeline run
  covering all of them, one combined verification.
- `solo` — big/risky tasks (or ones with no settled implementation yet) that earn the full
  pipeline on their own.
- `human` — needs the live dev stack, a live Claude Code session, or a real browser; **excluded
  from the automated workflow**; done interactively.

A unit is done only when all its sub-items are checked AND its merge to `v2-pty-injection` is
ancestry-proven (`git merge-base --is-ancestor <tip> v2-pty-injection`).

### Phase 0 — Critical safety: cross-session content leak

- [x] **BF0.1 `[solo]` "scanner-hook-gating"** (Issue #1 — `packages/cli/src/claude/scanner.ts`
      only, but high-risk single-file surgery; goes first and alone given severity)
  - [x] Add a `hookConfirmed` flag (seeded `opts.sessionId !== null`) and flip it to `true` only
        inside the public `onNewSession` entry point `createSessionScanner` returns
  - [x] Gate `watchProjectDirectoryForNewSessions`'s callback on it: once `hookConfirmed` is
        true, never call `announceNewSession` for a file that isn't `currentSessionId` — log and
        ignore instead of adopting it
  - [x] Split `announceNewSession`'s revival branch so a fallback-sourced call can never
        `deadSessions.delete(sessionId)` — thread a `source: "hook" | "fallback"` flag through
        and only allow revival for `"hook"`
  - [x] Time-box the fallback's authority even in the no-hook case: arm a
        `FALLBACK_ARMED_WINDOW_MS` (~30s) window from scanner start (re-armed briefly after
        `onGaveUp`), and ignore any new-file callback once that window has expired
  - [x] Tests (`scanner.test.ts`): (a) a hook-confirmed scanner never adopts a sibling `B.jsonl`
        file even after its own tracked session was dropped; (b) a no-hook-coverage scanner
        still rotates onto `B` (the fallback keeps working, just time-boxed); (c) the fallback
        window's expiry is respected
  - [ ] `[human]` live: repeat the original two-real-tmux-panes repro (same cwd, one session
        force-delayed past `missingFileTimeoutMs`) and confirm via server-side decryption that
        the delayed session's stored messages never contain the other pane's content

### Phase 1 — CLI-side sync & render correctness

- [x] **BF1.1 `[inline]` "core-loop-trivia"** — two small, unrelated, disjoint-file fixes
      batched into one pass (mirrors plan-v2.md's U1.1 mixed-package precedent)
  - [x] Issue #2 (already fixed — verify only, do not re-implement): confirm
        `session-state.test.ts`'s existing "never lets a stuck-true ephemeral override a turn
        that has already closed" case still passes; add one assertion to
        `SessionTimelineScreen`'s render test confirming it calls
        `deriveWorking(items, ephemeralWorking)` directly, so a future refactor can't silently
        reintroduce the old `ephemeralWorking || isTurnOpen(items)` inline form
  - [x] Issue #11: fix `packages/cli/src/auth/pair.ts`'s `delay()` helper to remove its `abort`
        listener on the timer-resolves path too (not only when the signal actually aborts),
        matching `scanner.ts`'s own already-correct `wait()` pattern — declare `onAbort` before
        the timer so the timer callback can call `signal?.removeEventListener("abort", onAbort)`
  - [x] Tests: new/extended `packages/cli/src/auth/pair.test.ts` — call
        `delay(10, controller.signal)` in a loop ~20 times without ever aborting and assert
        `addEventListener`/`removeEventListener` call counts match (no leaked listeners)
  - [x] Combined: scoped tests + `pnpm typecheck` + commit

- [x] **BF1.2 `[bundle]` "model-switch-render-fix"** (Issue #4 —
      `packages/cli/src/claude/envelopeMapper.ts` + `packages/cli/src/claude/modelChange.ts`)
  - [x] Export `normalizeTranscriptText` from `modelChange.ts` (currently private) so
        `envelopeMapper.ts` can reuse its ANSI-stripping instead of duplicating it
  - [x] Add `extractLocalCommandStdout`/`isLocalCommandInvocation` helpers to
        `envelopeMapper.ts` (regex-matching `<local-command-stdout>...</local-command-stdout>`
        / `<command-name>...</command-name>`), alongside the existing `isCompactSummaryMessage`
        helper
  - [x] In the `message.type === "user"`, string-content branch (before the existing
        `isSidechainMessage` check): a matched `local-command-stdout` becomes a quiet
        `agent`/`service` envelope with `normalizeTranscriptText`-cleaned text; a bare
        invocation record (`<command-name>` with no stdout yet) is dropped rather than shown as
        a raw chat bubble
  - [x] Confirm `findClaudeModelChangeInEnvelopes`'s model-chip side channel still works
        unchanged against the now-cleaned `service` text
  - [x] Tests: capture a real `/model haiku` transcript (invocation + `<local-command-stdout>`
        result) into a new CLI fixture and assert `mapClaudeToEnvelopes` produces one clean
        `service` envelope with no XML tags/ANSI codes; extend `modelChange.test.ts` with the
        same strings
  - [ ] `[human]` live: run `falcon claude`, type `/model haiku`, confirm the web timeline shows
        a clean "Set model to Haiku 4.5..." service line (no visible tags/escape codes) and the
        model chip still updates

- [x] **BF1.3 `[bundle]` "permission-mode-sync"** (Issue #5 — `packages/wire/src/session.ts`,
      `packages/cli/src/claude/pretoolPermissionBridge.ts`,
      `packages/web/src/sync/reducer/{types,reduce}.ts`,
      `packages/web/src/features/session-control/session-state.ts`)
  - [x] Add an additive `permission-mode` wire event variant
        (`{t:"permission-mode", mode: PermissionModeSchema, source: "terminal"|"client"}`)
        alongside `mode-switch` in `session.ts`'s `SessionEventSchema`
  - [x] In `pretoolPermissionBridge.ts`'s `cachePermissionMode`, emit the new event via the
        already-wired `emitEnvelope` dep whenever the observed mode genuinely changes (not on
        every hook echo) — decide and document whether the very first observed mode should also
        emit
  - [x] Add a matching `PermissionModeItem` `RenderItem` kind and reducer case (`reduce.ts`)
        mirroring `mode-switch`'s existing handling
  - [x] Extend `deriveCurrentPermissionMode` (`session-state.ts`) with a new case for
        `kind === "permission-mode"`, keeping the existing `perm-placeholder`/`tool`-decision
        cases so a web-initiated switch still reflects immediately pending the hook echo
  - [x] Tests: `pretoolPermissionBridge.test.ts` — two hook calls with different
        `permission_mode` values emit exactly one `permission-mode` event on the real
        transition; `session-state.test.ts` — a `permission-mode` item with `source:"terminal"`
        updates `deriveCurrentPermissionMode` independent of any pending decision
  - [ ] `[human]` live: press Shift+Tab in the live TUI to cycle to `acceptEdits`, confirm the
        web `ComposerControls` mode chip updates within one tool-call hook round-trip with no
        web-side action

### Phase 2 — Web tool-cards & UI polish

- [x] **BF2.1 `[bundle]` "plan-and-task-cards"** (Issues #6+#7 — both land in
      `packages/web/src/components/timeline/tool-cards/`'s registry + new card files)
  - [x] Issue #6: add `parseExitPlanModeArgs` to `lib/tool-args.ts`; add
        `ExitPlanModeToolCard.tsx` (rendering the `plan` field's markdown via the existing
        `Markdown` component inside `ToolCardShell`, falling back to a "No plan text recorded"
        message); register both `ExitPlanMode`/`exit_plan_mode` in `registry.tsx`
  - [x] Issue #6 tests: `ExitPlanModeToolCard.test.ts` (plan renders; malformed/missing plan
        falls back safely) and a `registry.test.ts` case asserting both spellings resolve to the
        new card, not `McpGenericCard`
  - [ ] Issue #7 — precondition, `[human]`: capture a real `TaskCreate`/`TaskUpdate` transcript
        from a live multi-step agentic session into
        `packages/cli/src/claude/__fixtures__/task-create-update-session.jsonl` (following the
        `task_sdk.jsonl`/`task_non_sdk.jsonl` convention) — the real args/output shape is
        currently unverified anywhere in this codebase and must not be guessed
  - [x] Issue #7 — only once that fixture exists: add a defensive parser to `tool-args.ts`
        matching the fixture's real field names, a `TaskEntryCard` (sibling of `TodoCard`), and
        register `TaskCreate`/`TaskUpdate` in `registry.tsx`; if the fixture isn't available
        yet, skip this sub-task rather than shipping a guessed schema — the current raw-JSON
        fallback is honest and strictly better than a wrong-but-confident card
  - [ ] `[human]` live: enter plan mode and trigger `ExitPlanMode`, confirm readable plan text
        with a working Allow/Deny row; if the Issue #7 fixture was captured, also trigger a real
        `TaskCreate`/`TaskUpdate` call and confirm a readable checklist view

- [x] **BF2.2 `[inline]` "web-polish-batch"** — three small, disjoint-file web fixes batched
      into one pass (verified: `SessionTimelineScreen.tsx` vs `SubagentGroup.tsx`+
      `RenderItemGroups.tsx` vs `live-source.ts`+`types.ts`+`session-card.tsx` share no files)
  - [x] Issue #3: change `SessionTimelineScreen.tsx`'s message-list wrapper from
        `<div className="min-h-0 flex-1 overflow-hidden">` to
        `<div className="flex min-h-0 flex-1 flex-col overflow-hidden">` so `Conversation`'s
        `flex-1 min-h-0` classes actually constrain its height (matching the other flex-col
        wrappers already in this file)
  - [x] Issue #8: change `SubagentGroup`'s prop from a raw `id` to a computed display `label`;
        in `RenderItemGroups.tsx`, compute an ordinal ("Subagent 1", "Subagent 2", ...) per
        standalone group instead of forwarding the internal `subagentId` cuid2 into visible
        text (the id stays only in the React `key`)
  - [x] Issue #13: change `SessionListSession.title`/`SessionListMachine.name` to
        `string | null` in `types.ts`; in `live-source.ts`'s `buildSnapshot`, stop defaulting
        through `?? UNTITLED_SESSION`/`?? UNNAMED_MACHINE` at read time — carry `null` when the
        titles map has no entry yet; in `session-card.tsx` (and the equivalent machine-badge
        render), show the existing `Skeleton` component when the title is `null`, only falling
        back to the literal placeholder text once decryption has genuinely completed with no
        usable title
  - [x] Tests: `RenderItemGroups.test.ts` (two standalone subagent groups render "Subagent 1"/
        "Subagent 2", no cuid-shaped substring); `live-source.test.ts` (empty titles maps →
        `null`, not placeholder strings) and a `session-card` render-test case (`null` title →
        `Skeleton`, string title → text)
  - [x] Combined: scoped tests + `pnpm typecheck` + commit; Issue #3 has no automated test
        (jsdom doesn't compute real layout) — note this honestly rather than fabricating a
        layout assertion

### Phase 3 — Auth & session robustness

- [x] **BF3.1 `[bundle]` "jwt-expiry-and-reconnect"** (Issues #9+#10 —
      `packages/web/src/lib/session.ts`, `apiSocket.ts`, `use-connectivity.ts`,
      `OfflineBanner.tsx`; bundled for design coupling, not direct file overlap — #10's own
      proposed fix says it "should share this same signal" as #9's `isTokenExpired()`)
  - [x] Issue #9: add `isTokenExpired()`/`decodeJwtExp()` to `session.ts` (base64url-decode the
        JWT payload, compare `exp` to now — no signature verification, a UX freshness check
        only) and make `isSignedIn()` require both a present token and `!isTokenExpired()`
  - [x] Issue #9: surface expiry proactively — a periodic check or dedicated hook that redirects
        to `/signin/` once `isTokenExpired()` flips true, rather than waiting for a socket
        reconnect to fail
  - [x] Issue #10: add a `connect_error` handler in `apiSocket.ts`, translating an
        auth-rejection message into a new `authError` event (and unsubscribing it in
        `teardown()`); stop the infinite retry loop (`apiSocket.disconnect()`) once it fires,
        since `reconnectionAttempts: Infinity` has no way to know the failure is permanent on
        its own
  - [x] Issue #10: extend `ConnectivitySource`/`useConnectivity` with an `authExpired` state
        driven by `authError`; have `OfflineBanner` branch on it before the generic
        "Reconnecting…" copy, showing a "Your session expired — sign in again" message linking
        to `/signin/`
  - [x] Tests: `session.test.ts` (far-future/past/malformed `exp` cases); `apiSocket.test.ts`
        (a fake socket emitting `connect_error` with an auth-rejection message → `authError`
        emitted); `use-connectivity.test.ts` (`authExpired` state)
  - [ ] `[human]` live: manually set an expired JWT into `localStorage`, reload, confirm a
        proactive "sign in again" state appears (Issue #9) and that the banner switches to
        "Sign in again" within one retry cycle rather than showing "Reconnecting…" forever,
        reaching `/signin/` on click (Issue #10)

- [ ] **BF3.2 `[solo]` "recovery-code-restore"** (Issue #12 — the biggest/riskiest web auth
      change; touches `packages/web/src/app/(public)/signin/page.tsx` + a new
      `RecoveryCodeInput` component; no server/schema changes needed)
  - [ ] Add a `restoring` status branch to `signin/page.tsx` and a
        `restoreFromRecoveryCode(bridge, code)` handler: `decodeRecoveryCode(code)` (from
        `@falcon/crypto`, already tested, currently unused anywhere in `packages/web/src`) → on
        success `bridge.init(masterSecret)` → `completeChallengeSignIn(bridge)` (the existing
        returning-device path) → redirect; on a malformed code or a challenge-sign-in failure,
        show an inline error without side effects
  - [ ] Add a "Restore from recovery code" entry point to the `needs-signup` render branch,
        above the existing OAuth buttons, following `recovery-code-card.tsx`'s existing styling
        conventions
  - [ ] Do not touch `oauth.ts`/`schema.ts` or the pairing redirect logic — restoring the
        *original* `signPublicKey` makes the account-collision problem moot, so the existing
        `/v1/auth` challenge-response route already resolves to the correct account with no
        server change
  - [ ] Tests: a component test for the new branch asserting the recovery-code input calls
        `decodeRecoveryCode` → `bridge.init` → `completeChallengeSignIn` in order with a fake
        `CryptoBridgeClient`; a malformed-code case asserting the inline error appears without
        calling `bridge.init`
  - [ ] `[human]` live: sign up fresh, reveal the recovery code from `/settings/recovery/`,
        clear the browser's storage (or use a private/second profile), redeem the code on
        `/signin/`, and confirm it restores the *same* account (same sessions/title data)
        rather than landing on an empty new account; also verify the negative case — an
        invalid code shows an inline error and creates no new account

### Phase 4 — landing `[human]`

- [ ] **BF4.1** Live re-verification checklist — every issue below was originally confirmed via
      live browser/tmux testing, not pure code-reading, so each needs a fresh live pass against
      the fixes above before this document's findings are considered closed:
  - [ ] Issue #1: two real tmux panes, same cwd, one session force-delayed past
        `missingFileTimeoutMs` — confirm via server-side decryption the delayed session's
        stored messages never contain the other pane's content
  - [ ] Issue #2: confirm the stuck-"Working…" regression does not reappear (a
        Stop-hook-before-transcript-write race)
  - [ ] Issue #4: `falcon claude`, `/model haiku` — clean service line, no XML/ANSI, model chip
        updates
  - [ ] Issue #5: Shift+Tab in the live TUI — web mode chip updates within one tool-call
        round-trip
  - [ ] Issue #9: expired JWT in `localStorage`, reload — proactive "sign in again" state, not
        silent failure
  - [ ] Issue #10: reload with an expired token — banner reads "Sign in again," not
        "Reconnecting…" forever
  - [ ] Issue #12: recovery-code redemption restores the original account's sessions on a wiped
        browser; an invalid code fails safely with no new account created
- [ ] **BF4.2** Final merge gate: `pnpm build && pnpm typecheck && pnpm test && pnpm lint` clean
      on the `v2-pty-injection` tip; confirm every BF unit's merge commit is a proven ancestor
      (`git merge-base --is-ancestor <tip> v2-pty-injection`) before this bug-fix pass is
      considered landed
