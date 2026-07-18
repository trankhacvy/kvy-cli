# plan-v2.md — PTY-injection hardening + web production plan

**Scope:** every issue found in the 2026-07-18 full audit (3 code-audit passes over
`packages/cli`, `packages/web`, `packages/wire` on branch `v2-pty-injection`, plus an
ecosystem survey of happy / omnara / mobvibe / claude-remote-manager /
claude-code-anywhere / Anthropic's own Remote Control). 49 issues, grouped into 5 waves.
Every snippet below was written against the actual source as it exists on
`v2-pty-injection` @ `023628a` — file paths and signatures are real, not sketches.

**How to use this doc:** each item has a checkbox, the issue id from the audit catalog
(A1…E41), the files it touches, the design, code snippets for the load-bearing parts,
and the tests to add. Waves are ordered by dependency; within a wave items are mostly
independent. `pnpm build && pnpm typecheck && pnpm test && pnpm lint` green is the exit
gate for every item; the CLI must be rebuilt (`pnpm --filter falcon build`) before any
live re-test because `bin/falcon.mjs` runs `dist/`.

**Wire policy reminder:** `@falcon/wire` is additive-only forever (design §5.3,
`packages/wire/src/reserved.ts`, enforced by `additiveOnly.test.ts`). Every wire change
below is a new optional field, new enum member, or new schema — never a retype.

---

## Wave 0 — live gates & probes (do first, ~1 hour, no code merged)

These de-risk the two biggest design bets before any implementation.

### [ ] W0.1 Live-test the PTY branch baseline (prior session's blocker)

Stack up (postgres 5433 → server `:3005` w/ `FALCON_DEV_AUTH=1` → web `:3000` w/
`NEXT_PUBLIC_FALCON_DEV_AUTH=1` → `falcon auth login` → `falcon daemon stop && start`
from the env-exported shell). Then verify: `falcon claude` renders the normal TUI
(spawn-helper exec bit is currently intact), typing works, a web message injects
without takeover, a web-initiated Bash routes a PermCard to the web, a locally-typed
Bash prompts instantly at the terminal. Diagnose from `~/.falcon/logs/`.

### [x] W0.2 Probe: deny-with-answer steering for AskUserQuestion (gates Wave 2.1)

> **RESULT (2026-07-18): PASS.** Run live on claude 2.1.214: widget never rendered,
> model consumed the deny-reason answer ("Blue") and continued the same turn
> perfectly, no re-ask. W2.1/U2.1 primary path confirmed.

10 minutes, no Falcon code. Scratch settings file with a PreToolUse hook that denies
`AskUserQuestion` with an answer-shaped reason:

```jsonc
// /tmp/auq-probe-settings.json
{ "hooks": { "PreToolUse": [ { "matcher": "AskUserQuestion", "hooks": [ {
  "type": "command",
  "command": "printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"The user answered via a remote client:\\n- Which color?\\n  → Blue\\nProceed with these answers. Do not call AskUserQuestion again for these questions.\"},\"suppressOutput\":true}'"
} ] } ] } }
```

Run `claude --settings /tmp/auq-probe-settings.json`, prompt: *"Use the AskUserQuestion
tool to ask me which color I prefer (Red/Blue/Green), then tell me a fact about the
color I picked."* **Pass:** widget never renders; model proceeds with Blue, no re-ask.
**Fail:** model re-asks or stalls → Wave 2.1 falls back to its plain-text degraded mode
as the primary (see W2.1 step 4).

### [x] W0.3 Probe: `PermissionRequest` hook contract (gates Wave 1.1)

> **RESULT (2026-07-18): PASS — plan A confirmed** on claude 2.1.214 (interactive
> TUI via tmux; `-p` mode does NOT fire this hook — no prompt would ever show).
> Auto-allowed tools (this machine allowlists bare `Bash`) never fire it; a
> non-allowlisted `Write` fired it, the deny was honored (`Denied by
> PermissionRequest hook` in the TUI, no dialog), and stdin was:
> `{session_id, transcript_path, cwd, prompt_id, permission_mode,
> hook_event_name:"PermissionRequest", tool_name, tool_input,
> permission_suggestions:[{type:"setMode",mode,destination}]}`.
> ⚠️ Finding: after the deny the model created the file anyway via allowlisted
> Bash — real deny messages MUST append "Do not attempt this action another
> way." (folded into W1.1's deny copy below).

The fix for the permission-flood bug (A1) wants Claude Code's `PermissionRequest` hook
(fires only when a permission dialog *would actually be shown*, i.e. after
settings/allowlist/mode evaluation — the shape claude-remote-manager ships in
production). Verify on OUR installed Claude Code version:

```jsonc
// /tmp/permreq-probe-settings.json
{ "hooks": { "PermissionRequest": [ { "hooks": [ {
  "type": "command", "timeout": 30,
  "command": "cat > /tmp/permreq-payload.json; printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PermissionRequest\",\"decision\":{\"behavior\":\"deny\",\"message\":\"probe denial\"}}}'"
} ] } ] } }
```

Check: (a) hook fires for a Bash command that would prompt, and does NOT fire for a
Read that auto-allows; (b) `/tmp/permreq-payload.json` shows the stdin shape
(`tool_name`, `tool_input`, expected also `permission_suggestions`); (c) the deny is
honored and the TUI dialog never renders; (d) with the hook exiting 0 with no output,
the normal dialog renders. **Pass → Wave 1.1 plan A** (PermissionRequest).
**Fail/absent on our version → Wave 1.1 plan B** (keep PreToolUse, add Falcon-side
auto-allow rules — snippet included in W1.1).

---

## Wave 1 — make the core loop honest (CLI + the 3 web bugs + web safety)

### [ ] W1.1 (A1) Kill the web-turn permission flood

**Problem.** `PreToolPermissionBridge.handlePreToolUse`
(`packages/cli/src/claude/pretoolPermissionBridge.ts:231-285`) routes **every** tool of
a web-initiated turn to the web and blocks up to `DEFAULT_ANSWER_TIMEOUT_MS = 570_000`
(`:123`) before denying. Read/Grep/Glob included. One web message → a wall of
PermCards, and unanswered = a ~9.5-minute stall *per tool* then a deny that derails the
turn.

**Design (plan A, gated on W0.3 passing).** Split responsibilities across two hooks:

- `PreToolUse` (existing) — returns `ask` for everything except the `AskUserQuestion`
  special case (Wave 2.1). `ask` defers to Claude Code's own permission engine, which
  auto-allows whatever settings/mode/allowlists say — exactly like a local turn.
- `PermissionRequest` (new, 5th hook on the same server) — fires only for calls that
  genuinely need a human. Web turn → route through the existing bridge pipeline
  (perm-request envelope → PermCard → `perm.answer`); local turn → exit with no
  decision so the TUI dialog renders untouched.

This makes the web see *exactly* the prompts a terminal user would see. It also
shortens the sane timeout: a prompt that would block the TUI can wait a long time, but
keep 570s (it's now per-genuine-prompt, which is fine).

**Changes.**

1. `packages/cli/src/claude/hookServer.ts` — add the endpoint + settings entry.
   The forwarder script already handles blocking hooks generically via the
   `blocking = hookPath === '/hook/pre-tool-use'` check (`hookServer.ts:351`); widen it:

```ts
// hookServer.ts — forwarder: replace the single-path blocking check
const blocking = hookPath === '/hook/pre-tool-use' || hookPath === '/hook/permission-request';
```

```ts
// hookServer.ts — new schemas (next to PreToolUseHookBodySchema, :143)
const PermissionRequestHookBodySchema = z
  .object({
    tool_name: z.string().min(1),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    // Claude Code sends suggestions like "allow this command always" here;
    // passthrough — we surface them later (Wave 4) but never require them.
  })
  .passthrough();

const PermissionRequestHookOutputSchema = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal("PermissionRequest"),
    decision: z
      .object({
        behavior: z.enum(["allow", "deny"]),
        message: z.string().optional(),
      })
      .optional(),
  }),
});
```

```ts
// hookServer.ts — new deps member (next to onPreToolUse, :206)
/**
 * Invoked when Claude Code's `PermissionRequest` hook fires — a permission
 * dialog is about to be shown. Resolve with a decision to answer it
 * remotely, or with `undefined` to let the TUI dialog render normally.
 */
onPermissionRequest?: (
  input: PermissionRequestHookInput,
) => Promise<PermissionRequestHookOutput | undefined>;
```

```ts
// hookServer.ts — new route (next to /hook/pre-tool-use, :284)
app.post(
  "/hook/permission-request",
  { schema: { body: PermissionRequestHookBodySchema } },
  async (request, reply) => {
    logger?.debug("[hook-server] permission-request", { toolName: request.body.tool_name });
    const out = onPermissionRequest
      ? await onPermissionRequest(request.body as PermissionRequestHookInput)
      : undefined;
    if (!out) {
      // 204 → forwarder writes nothing → Claude Code shows its normal dialog.
      return reply.code(204).send();
    }
    return out;
  },
);
```

   The forwarder must treat a 204/empty body as "write nothing to stdout" — it already
   only writes on `statusCode === 200` (`hookServer.ts:372`), so no forwarder change
   beyond the `blocking` line.

```ts
// hookServer.ts — writeHookSettingsFile settings object (:417): add
PermissionRequest: [
  {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: command("/hook/permission-request"),
        timeout: HOOK_COMMAND_TIMEOUT_SECONDS,
      },
    ],
  },
],
```

2. `packages/cli/src/claude/pretoolPermissionBridge.ts` — the bridge grows a second
   entry point that reuses ALL the existing pipeline (pending map, timers,
   `perm-request`/`perm-resolve` emission, first-wins `resolve()`, agent-state):

```ts
// pretoolPermissionBridge.ts — new types
export interface PermissionRequestHookInput {
  tool_name: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface PermissionRequestHookOutput {
  hookSpecificOutput: {
    hookEventName: "PermissionRequest";
    decision?: { behavior: "allow" | "deny"; message?: string };
  };
}
```

```ts
// pretoolPermissionBridge.ts — new method on PreToolPermissionBridge.
// Same skeleton as handlePreToolUse, but (a) it only fires for calls Claude
// Code itself decided need a prompt, and (b) "no decision" (undefined) is the
// local-turn escape hatch instead of PreToolUse's "ask".
handlePermissionRequest(
  input: PermissionRequestHookInput,
): Promise<PermissionRequestHookOutput | undefined> {
  if (!this.deps.isWebTurnActive()) {
    this.deps.logger?.debug("[pretool-bridge] local turn — TUI dialog owns it", {
      toolName: input.tool_name,
    });
    return Promise.resolve(undefined);
  }
  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const reqId = createId();
  return new Promise((resolvePromise) => {
    const settle = (decision: PermDecision): void => {
      const behavior = decision.kind === "deny" ? "deny" : "allow";
      resolvePromise({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior,
            message:
              decision.kind === "deny"
                ? (decision.message ?? "Denied from the Falcon web UI.")
                : `Allowed from the Falcon web UI.`,
          },
        },
      });
    };
    const timer = this.setTimer(() => {
      const pending = this.permRequestPending.get(reqId);
      if (!pending) return;
      this.permRequestPending.delete(reqId);
      const decision: PermDecision = {
        kind: "deny",
        message: `No response from the web within ${Math.round(this.answerTimeoutMs / 1000)}s — denied.`,
      };
      this.finishRequest(reqId, decision, "denied");
      pending.settle(decision);
    }, this.answerTimeoutMs);
    this.permRequestPending.set(reqId, { settle, toolName, input: toolInput, timer });
    this.requests[reqId] = { tool: toolName, arguments: toolInput, createdAt: Date.now() };
    this.publishAgentState();
    this.deps.emitEnvelope(
      createEnvelope("agent", {
        t: "perm-request",
        reqId,
        name: toolName,
        args: toolInput,
        modes: availableModes(toolName),
      }),
    );
  });
}
```

   `resolve()` (`:293`) gains a lookup in `permRequestPending` before/alongside
   `pending` so one `perm.answer` RPC serves both hook types; a `{kind:"mode"}` answer
   maps to `behavior:"allow"` + fires `onModeChange` exactly as `mapDecision` does
   today (`:351-360`). `reset()` (`:322`) also drains `permRequestPending`.

3. `handlePreToolUse` (`:231`) collapses to: AskUserQuestion special case (Wave 2.1),
   else **always** `ask` — web-turn or not:

```ts
handlePreToolUse(input: PreToolUseHookInput): Promise<PreToolUseHookOutput> {
  if (isAskUserQuestion(input.tool_name)) return this.handleAskUserQuestion(input); // Wave 2.1
  // Everything else: defer to Claude Code's own permission engine. Auto-allowed
  // tools run silently; genuine prompts fire the PermissionRequest hook, where
  // the web-vs-terminal fork now lives.
  return Promise.resolve(output("ask", "Deferred to Claude Code's permission engine."));
}
```

4. `packages/cli/src/claude/remotePermissionHook.ts` — wire
   `onPermissionRequest: (input) => bridge.handlePermissionRequest(input)` into
   `startServer({...})` (`:127-136`). No signature change to the handle.

**Plan B (only if W0.3 fails):** keep the current PreToolUse routing but add an
auto-allow gate in front of the web round-trip, mirroring happy's read-only rules:
`READ_ONLY_TOOLS = new Set(["Read","Glob","Grep","LS","TodoWrite","WebSearch","WebFetch","NotebookRead","Task"])`
→ `output("allow", "Auto-allowed read-only tool (web-initiated turn).")`, plus honor
`input.permission_mode`: `bypassPermissions` → allow everything;
`acceptEdits` → also allow `Edit/MultiEdit/Write/NotebookEdit`. This is strictly worse
than plan A (it re-implements Claude's engine and ignores the user's allowlists) —
document that in the code comment.

**Tests.** Extend `pretoolPermissionBridge.test.ts`: local-turn PermissionRequest →
undefined; web-turn → envelope emitted + first-wins + timeout-deny; mode answer →
allow + onModeChange; `reset()` drains both maps. `hookServer` test: 204 handling +
settings file contains 5 hooks + forwarder blocking on the new path.

### [ ] W1.2 (A2) Turn attribution: epochs + watchdog instead of one boolean

**Problem.** `webTurnActive` is a single boolean (`remotePermissionHook.ts:106-115`)
flipped on inject and on the Stop hook. Interleaved local typing misroutes local
prompts to the web; a missed Stop hook (crash) leaves the flag stuck true forever.

**Design.** Keep the boolean semantics but make them self-healing and
locally-overridable:

1. **Local-typing override.** The PTY session already sees every real keystroke
   (`ptyClaudeSession.ts:407-410`). A locally-typed *submit* (`\r` / `\n` in raw stdin
   while not mid-injection) means the human took the conversation over → clear the web
   flag. This is a heuristic but errs in the safe direction (prompts go to the
   terminal, where a human demonstrably is).
2. **Watchdog.** Any web turn older than `WEB_TURN_MAX_MS` (default 30 min) auto-clears
   the flag; refreshed by activity (each PreToolUse/PermissionRequest firing while the
   flag is set counts as activity).

**Changes.**

```ts
// remotePermissionHook.ts — replace the boolean block (:106-115)
const WEB_TURN_MAX_MS = 30 * 60 * 1000;
let webTurnStartedAt: number | null = null;
let webTurnLastActivityAt = 0;
const isWebTurnActive = () => {
  if (webTurnStartedAt === null) return false;
  if (Date.now() - webTurnLastActivityAt > WEB_TURN_MAX_MS) {
    opts.logger?.warn("[remote-perm-hook] web-turn flag expired via watchdog");
    webTurnStartedAt = null;
    return false;
  }
  webTurnLastActivityAt = Date.now(); // hook traffic while active keeps it alive
  return true;
};
const markWebTurnStart = () => {
  webTurnStartedAt = Date.now();
  webTurnLastActivityAt = webTurnStartedAt;
  opts.logger?.debug("[remote-perm-hook] web turn started");
};
const markTurnEnd = () => {
  webTurnStartedAt = null;
  opts.logger?.debug("[remote-perm-hook] turn ended");
};
```

   Handle gains `markLocalActivity: () => void` (alias of `markTurnEnd` with its own
   log line) exported alongside `markWebTurnStart`/`markTurnEnd`.

```ts
// ptyClaudeSession.ts — options gain an optional callback
/** Fires when the human at the real terminal submits input (Enter outside injection). */
onLocalSubmit?: () => void;
```

```ts
// ptyClaudeSession.ts — inside onStdinData (:407), before the PTY write
const onStdinData = (data: Buffer): void => {
  if (!controller.isInjecting && (data.includes(0x0d) || data.includes(0x0a))) {
    opts.onLocalSubmit?.();
  }
  ptyProcess?.write(data.toString("utf8"));
};
```

   (`InjectionController` gains a public `get isInjecting(): boolean` returning
   `this.injecting` — one line.)

```ts
// start.ts runLocalPty — wire it (inside runPtySession options, next to onInjected :448)
onLocalSubmit: () => permHook?.markLocalActivity(),
```

**Known residual (documented, accepted):** a local Enter during a still-genuinely-
running web turn flips subsequent prompts to the terminal. That is the intended
tiebreak — a present human beats a remote one; the web PermCard for the pre-flip
request still resolves via first-wins.

**Tests.** remotePermissionHook tests: watchdog expiry (fake timers), local-submit
clears, PermissionRequest during active refreshes.

### [ ] W1.3 (A3) Injection gate: prompt-open + local-draft guards

**Problem.** `canInject()` (`injectionController.ts:142-151`) knows only
`ready/busy/injecting/cooldown`. Busy derives solely from fetch-in-flight
(`ptyClaudeSession.ts:263-277`), so an open permission dialog / AskUserQuestion widget
/ trust prompt / half-typed local draft are all "idle" → the queued web message is
typed into them.

**Design.** Two new gate inputs, both owned by things we already observe:

1. **`promptOpen`** — set true when the hook layer knows a dialog is (or is about to
   be) on screen: a PreToolUse returned `ask` on a local turn, a PermissionRequest hook
   is being held, or Claude Code's `Notification` hook fired `perm`. Cleared on the
   next tool_result observed by the tailer, on `Stop`, and by a 120s failsafe timer.
2. **`localDraftActive`** — set true on any printable local keystroke, cleared on local
   submit (`\r`) or Escape or a 15s idle timer. While true, injection waits.

**Changes.**

```ts
// injectionController.ts — new state + setters (next to setBusy :113)
private promptOpen = false;
private localDraft = false;

/** A TUI dialog (permission prompt / widget) is on screen — never type into it. */
setPromptOpen(open: boolean): void {
  if (this.disposed || this.promptOpen === open) return;
  this.promptOpen = open;
  if (!open) this.tryFlush();
}

/** The human is mid-draft at the real keyboard — don't clobber their composer. */
setLocalDraft(active: boolean): void {
  if (this.disposed || this.localDraft === active) return;
  this.localDraft = active;
  if (!active) this.tryFlush();
}

private canInject(): boolean {
  return (
    !this.disposed && this.ready && !this.busy && !this.injecting &&
    !this.cooldown && !this.promptOpen && !this.localDraft && this.queue.length > 0
  );
}
```

```ts
// ptyClaudeSession.ts — local-draft tracking inside onStdinData (with W1.2's changes)
let draftIdleTimer: ReturnType<typeof setTimeout> | null = null;
const DRAFT_IDLE_MS = 15_000;
const onStdinData = (data: Buffer): void => {
  if (!controller.isInjecting) {
    if (data.includes(0x0d) || data.includes(0x0a) || data.includes(0x1b)) {
      controller.setLocalDraft(false);
      if (data.includes(0x0d) || data.includes(0x0a)) opts.onLocalSubmit?.();
    } else if (data.some((b) => b >= 0x20 || b === 0x08 || b === 0x7f)) {
      controller.setLocalDraft(true);
      if (draftIdleTimer) clearTimeoutImpl(draftIdleTimer);
      draftIdleTimer = setTimeoutImpl(() => controller.setLocalDraft(false), DRAFT_IDLE_MS);
    }
  }
  ptyProcess?.write(data.toString("utf8"));
};
cleanups.push(() => { if (draftIdleTimer) clearTimeoutImpl(draftIdleTimer); });
```

```ts
// ptyClaudeSession.ts — options gain the prompt-open input; start.ts wires it
/** Reflects "a TUI dialog is open" from the hook layer — gates injection. */
// handle addition:
setPromptOpen(open: boolean): void;   // → controller.setPromptOpen(open)
```

```ts
// start.ts runLocalPty — wire attention → prompt gate (replace the log-only
// onAttention at :421)
onAttention: (kind) => {
  logger.debug("[start-claude] attention from hook", { kind });
  if (kind === "perm") ptyHandle?.setPromptOpen(true);
  if (kind === "done") ptyHandle?.setPromptOpen(false);
},
```

   Additionally, the bridge signals dialog-lifetime precisely on the local-turn path:
   `handlePreToolUse`'s local-`ask` return and `handlePermissionRequest`'s
   local-`undefined` return both call a new `deps.onPromptLikely?.()`;
   `remotePermissionHook` forwards that to the same `setPromptOpen(true)` sink, and the
   tailer's next `tool-end` envelope (observed in `start.ts`'s `onEnvelopes` wrapper)
   clears it:

```ts
// start.ts runLocalPty — clear promptOpen when a tool_result lands
onEnvelopes: (envelopes) => {
  if (envelopes.some((e) => e.ev.t === "tool-end")) ptyHandle?.setPromptOpen(false);
  outbox.enqueue(envelopes);
},
```

   Failsafe: `setPromptOpen(true)` in the controller arms a 120s timer that
   self-clears (a dialog that vanished without any observed signal must not
   starve the queue forever).

**Tests.** Controller: promptOpen blocks, clears+flushes; draft blocks; failsafe timer.
ptyClaudeSession: draft detection from stdin bytes; attention wiring.

### [ ] W1.4 (A4 + B15) Session lifecycle status: ended/failed on the PTY path

**Problem.** The CLI never reports any status on the PTY path. `sessionStatus.ts` only
knows `failed` and is unwired; no SIGINT/SIGTERM handlers exist in `start.ts`; the web
infers nothing when a session ends (`api/sessionStatus.ts`, audit §1/§8/§10).

**Design.** Additive `ended` status + a small `reportSessionStatus` generalization +
wiring at the three exits (normal child exit, signals, crash).

1. `packages/cli/src/api/sessionStatus.ts` — generalize (keep `reportSessionFailed` as
   a thin wrapper so existing callers/tests stand):

```ts
export type ReportableSessionStatus = "failed" | "ended";

export async function reportSessionStatus(
  deps: ReportSessionFailedDeps,
  params: { sessionId: string; status: ReportableSessionStatus; error?: Error },
): Promise<ReportSessionFailedResult> {
  // body: POST `${backendUrl}/v1/sessions/${sessionId}/status`
  // JSON: { status: params.status, ...(params.error ? { error: message } : {}) }
  // identical fetch/timeout/error handling to the existing implementation.
}
```

2. `packages/server` — the `POST /v1/sessions/:id/status` route's zod enum gains
   `"ended"` (additive), sets `sessions.status`, bumps headerSeq, fans out
   `session-update` through the eventRouter exactly as `failed` does today.

3. `packages/cli/src/commands/start.ts` — wire all exits in `runLocalPty` and the
   shared outer scope:

```ts
// start.ts — once, after bootstrap succeeds (near :308)
const statusDeps = {
  backendUrl,
  accessToken: credentials.token,
  fetchImpl,
  logger,
};
let statusReported = false;
const reportStatusOnce = async (
  status: ReportableSessionStatus,
  error?: Error,
): Promise<void> => {
  if (statusReported) return;
  statusReported = true;
  await reportSessionStatus(statusDeps, { sessionId: bootstrap.sessionId, status, error });
};

// Signal handlers: SIGINT reaches the child via the PTY (raw mode forwards
// Ctrl-C bytes), but SIGTERM/SIGHUP on the falcon process itself must still
// end the session honestly.
const onSignal = (signal: NodeJS.Signals) => {
  logger.info("[start-claude] signal — ending session", { signal });
  void reportStatusOnce("ended").finally(() => {
    process.exit(signal === "SIGTERM" ? 0 : 1);
  });
};
process.on("SIGTERM", onSignal);
process.on("SIGHUP", onSignal);
```

```ts
// start.ts runLocalPty — the normal-exit path (inside the existing try/finally :489)
try {
  const code = await ptySession.done;
  await reportStatusOnce(code === 0 ? "ended" : "failed",
    code === 0 ? undefined : new Error(`claude exited with code ${code}`));
  return code;
} finally { ... }
```

4. **Web rendering** (`packages/web`): `deriveSessionStatus`
   (`features/session-list/status.ts`) and the timeline header
   (`SessionTimelineScreen.tsx:114`) branch on `session.status === "ended" | "failed"`
   from the `['sync']` snapshot — "Ended" chip on Home, "Session ended" banner +
   disabled Composer/ControlBar on the timeline. The `session-update` fan-out already
   reaches the web via the sync engine's header stream; no new plumbing.

**Tests.** sessionStatus unit (ended body), start.test: exit-code → status mapping;
server route test for the enum member; web: status chip snapshot.

### [ ] W1.5 (B11) Real interrupt from the web (Escape injection)

**Problem.** `interrupt: async () => ({ ok: false })` (`start.ts:470`).

**Design.** Escape is the one keystroke that is safe to fire regardless of TUI state:
mid-turn it cancels the turn; at an idle prompt it's a no-op; inside a menu it closes
the menu (recoverable). Gate it on `working` knowledge we already have (fetch busy) to
avoid the menu case in practice.

```ts
// ptyClaudeSession.ts — handle gains
/** Sends a single Escape into the PTY — the TUI's own cancel gesture. */
sendInterrupt(): boolean;
// impl (next to injectMessage in the returned handle):
sendInterrupt: () => {
  if (!ptyProcess) return false;
  ptyProcess.write("\u001b"); // ESC, the TUI's own cancel gesture
  return true;
},
```

```ts
// start.ts runLocalPty rpcHandlers — replace the stub (:470)
interrupt: async () => ({ ok: ptySession.sendInterrupt() }),
```

Web side needs nothing: ControlBar already calls `actions.interrupt()` and disables on
`!working` (`ControlBar.tsx:49,69-76`).

**Tests.** pty session unit: sendInterrupt writes `\x1b`; start.test: RPC → ok:true.

### [ ] W1.6 (D24) Timeline auto-scroll + scroll-to-bottom button

**Problem.** `Timeline.tsx` never scrolls (`:16-66`).

**Design.** Stick-to-bottom (the AI Elements `Conversation` pattern): auto-follow while
the user is at (or near) the bottom; stop following the moment they scroll up; float a
"↓ Jump to latest" button while not following.

```tsx
// packages/web/src/components/timeline/Timeline.tsx — replace the component body
export function Timeline({ items, working = false }: { items: RenderItem[]; working?: boolean }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 96,
    overscan: 8,
    getItemKey: (index) => {
      const item = items[index];
      return item ? `${item.id}:${item.kind}` : index;
    },
  });

  // Follow the tail while the user is at the bottom.
  useEffect(() => {
    if (following && items.length > 0) {
      virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    }
  }, [items.length, following, virtualizer]);

  // Leaving the bottom (by >1.5 viewports) pauses following; returning resumes it.
  const onScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setFollowing(distanceFromBottom < el.clientHeight * 0.5);
  };

  if (items.length === 0) { /* unchanged empty state */ }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={parentRef} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-4">
        {/* unchanged virtualizer inner container */}
      </div>
      {!following && (
        <button
          type="button"
          onClick={() => {
            setFollowing(true);
            virtualizer.scrollToIndex(items.length - 1, { align: "end" });
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs shadow-md hover:bg-muted"
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}
```

Dynamic-height caveat: `scrollToIndex(last, {align:"end"})` with `measureElement` can
land slightly short on unmeasured rows; re-run it in a `requestAnimationFrame` after
the first call (one-line follow-up) — verify against a long fixture during W0.1's
stack.

**Tests.** Component test with a scrollable fixture: appending while at bottom keeps
bottom; appending while scrolled up shows the button; clicking resumes.

### [ ] W1.7 (D25) Thinking indicator honesty

**Problem.** `ThinkingBlock.tsx:17` renders the static string `"Thinking…"` for every
collapsed finished thinking block, forever.

**Design.** The block itself is *always* historical once rendered (the reducer only
emits complete envelopes) — so the collapsed label should be past-tense; the *live*
"thinking now" signal belongs to the activity row (W1.8).

```tsx
// ThinkingBlock.tsx — label fix (:17)
<span className="italic">{open ? "Hide thinking" : "Thought process"}</span>
```

Also cover the secondary stuck-"Working…" cause: `working` in
`SessionTimelineScreen.tsx:63` is `ephemeralWorking || isTurnOpen(items)`. Add a
freshness cap to the ephemeral half in `use-session-ephemerals.ts`: a `working:true`
ephemeral older than 60s with no successor is treated as false (ephemerals are
droppable by design — never trust one forever).

**Tests.** snapshot of collapsed label; ephemeral staleness unit test.

### [ ] W1.8 (D26) In-timeline activity row

**Problem.** While the agent works there is no in-timeline indication (only the header
"Working…"); with W1.6 the tail is visible, so a live row completes the picture.

**Design.** `SessionTimelineBody` already knows `working`; pass it to `Timeline`
(prop added in W1.6) and render a pseudo-row after the last item when
`working && last item is not a running tool`:

```tsx
// inside Timeline's scroll container, after the virtualized block
{working && (
  <div className="flex items-center gap-2 px-1 pt-1 text-xs text-muted-foreground">
    <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
    Working…
  </div>
)}
```

(Placed outside the virtualizer so it never affects measurement; it scrolls with the
container's natural bottom, which following keeps visible.)

### [ ] W1.9 (E39) Auth-gate the session routes

**Problem.** `/session/[id]`, `/session/[id]/git`, `/session/new` render for signed-out
visitors and throw from `getToken()` inside hooks (`use-live-render-items.ts:35`).

**Design.** Same gate `app/page.tsx:27` already uses — extract it:

```tsx
// packages/web/src/features/auth/require-auth.tsx (new)
"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { isSignedIn } from "@/features/auth"; // same helper page.tsx uses

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const signedIn = isSignedIn();
  useEffect(() => {
    if (!signedIn) router.replace("/signin/");
  }, [signedIn, router]);
  if (!signedIn) return null;
  return <>{children}</>;
}
```

Wrap the three page components. (Static export → this must stay a client-side gate;
match the exact `isSignedIn` import used by `app/page.tsx`.)

### [ ] W1.10 (E40) Error boundaries + decrypt-failure surface

1. Add `packages/web/src/app/error.tsx` + `app/not-found.tsx` (App-Router
   conventions; `error.tsx` shows message + "Try again" via `reset()`).
2. `use-live-render-items.ts:66-71`: on a page-level decrypt failure, surface instead
   of only `console.error` — return `{ items, error }` from the hook and render an
   inline destructive banner with a "Retry" that calls
   `queryClient.invalidateQueries({ queryKey: ["messages", sessionId] })`.

---

## Wave 2 — the approved features

### [ ] W2.1 (C16) AskUserQuestion end-to-end (deny-with-answer)

Gated by W0.2. Four pieces (design settled in the prior discussion; the ecosystem
survey confirmed no better mechanism exists for an attended TUI):

**1. CLI — `pretoolPermissionBridge.ts` special case.**

```ts
// pretoolPermissionBridge.ts — helpers
const isAskUserQuestion = (name: string): boolean =>
  name === "AskUserQuestion" || name === "ask_user_question";

interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string } | string>;
}

/** Compose the deny reason in Claude Code's own native answer format
 * (`- {question}\n  → {labels}`) so the model reads it exactly like a real
 * AskUserQuestion result (format observed in claude-code-anywhere's
 * intercept.cjs, which mimics Claude Code's own). */
export function composeAskAnswerReason(
  questions: AskQuestion[],
  answers: Record<string, string>,
): string {
  const lines = questions.map((q) => `- ${q.question}\n  → ${answers[q.question] ?? "(no answer)"}`);
  return [
    "The user answered via the Falcon web UI:",
    ...lines,
    "Proceed using these answers. Do not call AskUserQuestion again for these questions.",
  ].join("\n");
}
```

```ts
// pretoolPermissionBridge.ts — the special-case handler (called from
// handlePreToolUse per W1.1 step 3). Reuses the whole existing pending
// pipeline; ONLY the mapDecision differs.
private handleAskUserQuestion(input: PreToolUseHookInput): Promise<PreToolUseHookOutput> {
  if (!this.deps.isWebTurnActive()) {
    // Local turn: the TUI widget renders; the human answers it there. The
    // tailer mirrors question+answer as tool-start/tool-end (read-only card).
    return Promise.resolve(output("ask", "Locally-initiated turn — answer the widget at the terminal."));
  }
  const toolInput = input.tool_input ?? {};
  const questions = (toolInput.questions ?? []) as AskQuestion[];
  const reqId = createId();
  return new Promise((resolvePromise) => {
    const timer = this.setTimer(() => {
      const pending = this.pending.get(reqId);
      if (!pending) return;
      this.pending.delete(reqId);
      // Degraded mode (also the W0.2-fail primary): turn the widget into a
      // plain conversational question — the composer handles the reply.
      const decision: PermDecision = { kind: "deny", message: ASK_FALLBACK_REASON };
      this.finishRequest(reqId, decision, "denied");
      pending.settle(output("deny", ASK_FALLBACK_REASON));
    }, this.answerTimeoutMs);
    this.pending.set(reqId, {
      settle: (out) => resolvePromise(out),
      toolName: input.tool_name,
      input: toolInput,
      timer,
      isQuestion: true,          // new optional field on PendingPreToolRequest
      questions,                 // kept for answer composition
    });
    this.requests[reqId] = { tool: input.tool_name, arguments: toolInput, createdAt: Date.now() };
    this.publishAgentState();
    this.deps.emitEnvelope(
      createEnvelope("agent", {
        t: "perm-request",
        reqId,
        name: input.tool_name,
        args: toolInput,
        modes: [],               // a question offers no mode switches
      }),
    );
  });
}

const ASK_FALLBACK_REASON =
  "The remote user did not answer the structured question form. Ask the same question(s) again in PLAIN TEXT in your reply (no AskUserQuestion tool), then end your turn and wait for the user's typed answer.";
```

```ts
// pretoolPermissionBridge.ts — inside mapDecision (:331), FIRST branch:
if (pending.isQuestion) {
  if (decision.kind === "allow" && isRecord(decision.updatedInput) &&
      isRecord((decision.updatedInput as Record<string, unknown>).answers)) {
    const answers = (decision.updatedInput as { answers: Record<string, string> }).answers;
    return output("deny", composeAskAnswerReason(pending.questions ?? [], answers));
    // deny-with-answer: the widget never renders; Claude reads the reason as
    // the user's answer and continues the same turn (probe-verified, W0.2).
  }
  if (decision.kind === "deny") {
    return output("deny", decision.message ?? ASK_FALLBACK_REASON);
  }
  // Any other decision shape for a question degrades to the plain-text fallback.
  return output("deny", ASK_FALLBACK_REASON);
}
```

**2. Wire — zero change.** The answer rides the existing
`PermDecisionSchema.allow.updatedInput` (`packages/wire/src/permissions.ts:19`) as
`{ kind: "allow", scope: "once", updatedInput: { answers } }` — happy's exact shape
(`happy-app/.../AskUserQuestionView.tsx:241`).

**3. Web — question card** (`packages/web/src/components/timeline/AskUserQuestionCard.tsx`,
new; happy's layout + claude-remote-manager's multiSelect UX):

```tsx
"use client";
// Selectable multiple-choice card for a pending AskUserQuestion perm-request.
// Rendered instead of PermCard when permission.name === "AskUserQuestion"
// (same tool-name dispatch happy uses — ToolView.tsx:171-175/244).
export function AskUserQuestionCard({ args, permission }: {
  args: unknown;
  permission: PermissionInfo;
}) {
  const { actions } = useSessionControl();
  const questions = parseAskQuestions(args);           // zod-parse of {questions:[...]}
  const [selections, setSelections] = useState<Map<number, Set<number>>>(new Map());
  const [phase, setPhase] = useState<PermCardPhase>({ kind: "idle" });
  const mutation = useMutation({
    mutationFn: (decision: PermDecision) => actions.answerPermission(permission.reqId, decision),
  });

  if (permission.decision || phase.kind === "answered" || phase.kind === "lost-race") {
    return <AskAnsweredSummary questions={questions} permission={permission} phase={phase} />;
  }

  const toggle = (qi: number, oi: number, multi: boolean) =>
    setSelections((prev) => {
      const next = new Map(prev);
      const set = new Set(multi ? (next.get(qi) ?? []) : []);
      set.has(oi) ? set.delete(oi) : set.add(oi);
      next.set(qi, set);
      return next;
    });

  const allAnswered = questions.every((q, qi) => (selections.get(qi)?.size ?? 0) > 0);

  const submit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => {
      const labels = [...(selections.get(qi) ?? [])]
        .map((oi) => optionLabel(q.options[oi]))
        .filter(Boolean)
        .join(", ");
      answers[q.question] = labels;
    });
    const decision: PermDecision = { kind: "allow", scope: "once", updatedInput: { answers } };
    setPhase({ kind: "submitting", decision });
    mutation.mutate(decision, {
      onSuccess: (result) => setPhase(applyAnswerResult(decision, result)),
      onError: (error) => setPhase(fromError(error)),
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-sky-500/40 bg-sky-500/5 px-3 py-2 text-sm">
      {questions.map((q, qi) => (
        <div key={q.question} className="flex flex-col gap-1.5">
          {q.header && <Badge variant="secondary" className="w-fit">{q.header}</Badge>}
          <p className="font-medium">{q.question}</p>
          <div className="flex flex-col gap-1">
            {q.options.map((opt, oi) => {
              const selected = selections.get(qi)?.has(oi) ?? false;
              return (
                <button key={optionLabel(opt)} type="button"
                  onClick={() => toggle(qi, oi, q.multiSelect ?? false)}
                  className={cn("rounded-md border px-2.5 py-1.5 text-left",
                    selected ? "border-sky-500 bg-sky-500/10" : "border-border hover:bg-muted")}>
                  <span>{optionLabel(opt)}</span>
                  {optionDescription(opt) && (
                    <span className="block text-xs text-muted-foreground">{optionDescription(opt)}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <Button size="sm" disabled={!allAnswered || phase.kind === "submitting"} onClick={submit}>
        Submit answer{questions.length > 1 ? "s" : ""}
      </Button>
    </div>
  );
}
```

Dispatch: in the two `PermCard` call sites (`PermPlaceholder`, `ToolCardShell`), route
`name === "AskUserQuestion"` to this card (mirror of happy's PermissionFooter
suppression).

**4. Web — read-only ToolCard** (`tool-cards/AskUserQuestionToolCard.tsx` + registry
entry): renders `args.questions` + the `tool-end` output as a Q&A summary for
locally-answered questions (replaces the raw-JSON `McpGenericCard` fallback).

**Tests.** Bridge: local→ask; web→pending; answers→deny-with-composed-reason (exact
string snapshot); timeout→fallback reason; first-wins. `composeAskAnswerReason` unit.
Web: card renders single/multi/multiSelect, submit shape
`{kind:"allow",scope:"once",updatedInput:{answers}}`, answered/lost-race states.

### [ ] W2.2 (C17) ExitPlanMode plan card

**Problem.** The plan markdown arrives in `perm-request.args.plan` but renders as raw
JSON (`PermCard.tsx:140`).

**Fix.** In `PermCard`, before the JsonBlock fallback:

```tsx
// PermCard.tsx — after the editArgs branch (:139)
const planMd =
  (name === "ExitPlanMode" || name === "exit_plan_mode") &&
  typeof (args as { plan?: unknown })?.plan === "string"
    ? (args as { plan: string }).plan
    : null;
// …in the preview area:
) : planMd ? (
  <div className="max-h-96 overflow-y-auto rounded-md border border-border/60 bg-muted/20 px-3 py-2">
    <Markdown md={planMd} />
  </div>
) : (
  args !== undefined && <JsonBlock value={args} />
)}
```

The existing mode buttons already carry the approve semantics (`EXIT_PLAN_MODES` from
the bridge = default/acceptEdits/bypassPermissions → "Approve, then <mode>"); relabel
the buttons for this tool: `Allow` → "Approve plan", mode buttons → "Approve &
<mode>", `Deny` → "Keep planning". Cosmetic-only — the decision wire shapes are
unchanged.

### [ ] W2.3 (B10) Stop session from the web

**Design decision:** implement stop as a **session RPC**, not a machine RPC — the
session process is alive, connected, and owns its child; the daemon (which doesn't even
track terminal sessions, A9) isn't needed. Machine-RPC `stopSession` stays deferred for
dead/daemon-spawned sessions (Wave 4 note).

1. **Wire** (`packages/wire/src/rpc.ts`) — additive session-RPC schemas next to
   `InterruptResultSchema`:

```ts
export const StopRpcParamsSchema = z.object({
  /** Graceful by default; force ⇒ SIGKILL after grace. */
  force: z.boolean().optional(),
});
export const StopRpcResultSchema = z.object({ ok: z.boolean() });
```

2. **CLI** (`packages/cli/src/rpc/sessionRpc.ts`) — add `"stop"` to the method list
   (`:68-70`) + `stop: (params) => …` on `SessionRpcHandlers` (`:75`) +
   `defineMethod(StopRpcParamsSchema, StopRpcResultSchema, handlers.stop)`.

3. **`start.ts` runLocalPty:**

```ts
stop: async ({ force }) => {
  logger.info("[start-claude] stop requested from web", { force: force ?? false });
  await reportStatusOnce("ended");           // W1.4 — status lands BEFORE the WS drops
  ptySession.stop();                         // SIGTERM to the PTY child
  if (force) setTimeout(() => process.exit(0), 3000).unref();
  return { ok: true };
},
```

   (`runRemoteLoop` gets the analogous handler calling the loop's exit request.)

4. **Web** — `sync/sessionRpc.ts` gains `stop(force?)`; `SessionControlActions` gains
   `stopSession`; ControlBar gains an "End session" button behind a shadcn
   `Dialog` confirm ("Ends the CLI process on the machine — the terminal user
   will see Claude exit."). Disabled when `session.status !== "active"`.

**Tests.** RPC round-trip with fake handlers; start.test: stop → status ended + pty
stop called; web: confirm-dialog flow.

### [ ] W2.4 (E32 + B13) ControlBar honesty: real mode, real capabilities

1. **Mode display** — derive the current mode instead of the hardcoded `"default"`
   (`SessionTimelineScreen.tsx:122`): fold `mode-switch` + `perm-resolve{kind:"mode"}`
   envelopes in a tiny selector `deriveCurrentPermissionMode(items): PermissionMode`
   (new, in `features/session-control/status.ts` next to `deriveControlMode`), pass it
   through. Until W4's real setMode lands, the `<select>` becomes display +
   per-request-mode answers only.
2. **takeControl** — in PTY mode (`controlMode === "local"`), hide the "Take control"
   button entirely (it's a meaningless always-ok today, `start.ts:466`); shown only for
   remote-loop sessions.
3. **setMode** — keep returning `{ok:false}` from the CLI, but have the web *hide* the
   selector's mutating affordance for PTY sessions until W4.3, instead of showing an
   error after the fact.

---

## Wave 3 — coverage & live wiring

### [ ] W3.1 (C18) Tool-card registry parity

Add dedicated cards (all follow the `BashCard`/`ReadCard` pattern in
`packages/web/src/components/timeline/tool-cards/`): `WebFetch` (url + prompt +
collapsible result), `WebSearch` (query + result list), `NotebookEdit` (path + diff-ish
cell view), `LS` (path + entries). Registry additions in `registry.tsx:15-25`. The
`AskUserQuestion` + ExitPlanMode cards come from Wave 2. Benchmark for coverage:
happy's `knownTools.tsx` (19 native tools).

### [ ] W3.2 (C19) Images: transcript → `file` envelopes → timeline

**CLI** (`packages/cli/src/claude/envelopeMapper.ts`): in the user-message and
tool_result branches, map image blocks to the existing wire `file` event
(`packages/wire/src/session.ts` `t:"file"`), storing the base64 payload via the
existing blob/attachment path the web composer already uses for uploads
(`optimistic-composer.ts:63` precedent). First iteration (no blob subsystem on the CLI
yet): emit `file` with inline `ref: "inline:<base64>"` capped at 256KB, else a
`service` note "image omitted (too large)". Web: `FileItem` already renders; extend to
render `inline:` refs as `<img src="data:...">`.

### [ ] W3.3 (C20+C23) PTY-path parity: `risk` + `service`

- `envelopeMapper.ts` tool-start branch (`:537-545`): add the same `RISK_BY_KIND`-style
  static map ACP uses (`acpToEnvelope.ts:365-378`) keyed by tool name
  (Bash→exec, Edit/Write/MultiEdit/NotebookEdit→write, Read/Grep/Glob/LS→read,
  WebFetch/WebSearch→network).
- `start.ts` runLocalPty: emit `service` envelopes for lifecycle moments the web
  should see ("session started", "session ended", spawn failures) via
  `outbox.enqueue([createEnvelope("agent", { t: "service", text }) ])`.

### [ ] W3.4 (E35) New Session screen → live spawn

Swap the mock defaults in `new-session-screen.tsx:56-60` for live implementations
that exist already: machines list from the `['sync']` snapshot (same source the Home
screen uses, `live-source.ts`), spawn via `sync/machineRpc.ts`'s existing `spawn`
(already wired for `git.status`/`git.diff` — `machineRpcToGitDiffActions` precedent in
`features/git-diff/live-actions.ts`). Requires the per-machine crypto client the git
panel also needs — do together with W3.5.

### [ ] W3.5 (E36) Git panel → live

Replace `useMockGitDiffActions` default (`components/GitDiffPanel.tsx:26`) with
`machineRpcToGitDiffActions` fed by real ids: the session's `machineId` +
workspace path come from the decrypted session metadata in the `['sync']` snapshot —
plumb via the git route (`app/session/[id]/git/page.tsx:21` currently fabricates
`mach-${id}`). Blocked on the same per-machine DEK unwrap as W3.4 — build a shared
`use-machine-crypto.ts` mirroring `use-session-crypto.ts:18`.

### [ ] W3.6 (E37) Home screen real status dots + presence

`live-source.ts:221-222` hardcodes `items: []`/`attention: null`. Feed
`deriveSessionStatus` with: last ~50 `RenderItem`s per session (decrypt only the most
recent message page lazily per visible row — TanStack `useQueries`), and machine
presence from the `machine-presence` ephemeral (subscribe in the same hook that
already consumes ephemerals for the timeline, `use-session-ephemerals.ts`) instead of
the 3-minute `lastSeenAt` heuristic (`:61,183-185`).

### [ ] W3.7 (A5) Resume a PTY session

- `daemon/resumeSession.ts:239-244`: only force `--starting-mode remote` when the
  original session was daemon-spawned/headless; a resumed terminal session (no
  controlling TTY available to the daemon) must still spawn headless — so the real
  fix is: keep remote for daemon resume, and implement terminal resume as
  `falcon claude --resume`-equivalent: `bootstrap.ts` honors
  `FALCON_RECONNECT_SESSION_ID`/`FALCON_RECONNECT_PROVIDER_SESSION_ID` env
  (`resumeSession.ts:177-186` contract, currently consumed by nothing):

```ts
// session/bootstrap.ts — before minting a fresh tag/nonce
const reconnectSessionId = env.FALCON_RECONNECT_SESSION_ID;
if (reconnectSessionId) {
  // Re-attach: fetch the existing row + wrapped DEK instead of create-or-get.
  return reattachSession(deps, { sessionId: reconnectSessionId, contentKeyPair });
}
```

- `start.ts:436`: pass `providerSessionId: env.FALCON_RECONNECT_PROVIDER_SESSION_ID ?? null`
  so the PTY spawn resumes the provider transcript (`resolveSessionFlags` already
  handles `--resume` composition, `ptyClaudeSession.ts:341-352`).

### [ ] W3.8 (A6) Tailer: final flush + rotation follow

- `scanner.ts` `cleanup()` (`:288-294`): run one final `syncNow()` pass (the same body
  the 3s interval runs) before stopping watchers, so shutdown-tail entries are mapped.
- Rotation: watch the project transcript directory (`getProjectPath`, `:97`) for
  *new* `*.jsonl` files while a session is live; a new file whose first record's
  `sessionId` differs → `onNewSession(newId)` automatically (covers `/clear` and
  Claude-minted new ids when no `SessionStart` hook fires — hook coverage means this
  is a fallback, so debounce 2s and log when it triggers).

### [ ] W3.9 (A7) No silent message loss

- `injectionController.dispose()` (`:132-140`): return the dropped queue; callers
  (`ptyClaudeSession` teardown → `start.ts`) fail those claims:

```ts
// injectionController.ts
dispose(): PendingInjection[] {
  if (this.disposed) return [];
  this.disposed = true;
  /* … existing timer clears … */
  const dropped = this.queue.splice(0);
  return dropped;
}
```

```ts
// start.ts — via a new onDropped callback threaded through ptyClaudeSession opts
onDroppedInjections: (messages) => {
  for (const m of messages) completeClaim(m.id, { status: "dropped-session-ended" });
},
```

  Completing the claim (instead of leaving it open) makes a web retry an honest
  `duplicate` with a recorded terminal result rather than `outcome-unknown` for a
  message that never ran; the web composer already reconciles `duplicate`.
- Child-exit-mid-inject (write happened, submit skipped): in `tryFlush`'s submit
  callback the `this.disposed` early-return (`:164`) must also complete-as-dropped —
  route through the same `onDropped` path.

### [ ] W3.10 (E38) Unmanaged sessions → live

Swap `useMockUnmanagedSessions` defaults (`session-list-screen.tsx:41-42`) for a hook
over the `['sync']` snapshot's unmanaged rows (`unmanaged-new`/`unmanaged-update`
already fan out; the server route exists). Actions (mirror/adopt) stay disabled until
the adopt RPCs get live wiring — render read-only rows first.

---

## Wave 4 — polish & platform

### [ ] W4.1 (E27) Streaming text

Whole-message pop-in is CLI-shaped: the tailer only sees complete JSONL lines, so true
token streaming requires the mapper to emit partial text envelopes — **decision: don't.**
Instead reduce perceived latency: W1.8's activity row + W1.6 following make progress
visible; additionally coalesce flushes at 150ms (from 300ms) in the outbox for lower
batch latency. Revisit real streaming only if ACP remote mode (which does stream
chunks — they're coalesced in `acpToEnvelope`) becomes the dominant path.

### [ ] W4.2 (E28-E31, E33-E34, E41) Web polish batch

- Timestamps: `TimelineRow` renders `item.time` as a hover tooltip + hourly dividers.
- Copy buttons: `CodeBlock` (markdown pipeline output) + Bash command + message text —
  one `CopyButton` component.
- Theme: remove `className="dark"` hardcode (`layout.tsx:30`), add
  `next-themes`-style toggle in settings; shiki dual theme
  (`github-dark`/`github-light` via `rehype-pretty-code`'s `theme: {dark,light}`).
- Composer: auto-grow textarea (`field-sizing: content` + max-h), draft persistence
  (sessionStorage keyed by sessionId), multi-file attach + image thumbnail previews,
  disabled-until-crypto-ready attach button.
- Model selector: replace the free-text spawn field with a curated list +
  "custom…" escape hatch; display-only model chip in the session header (from session
  metadata once the CLI records it there).
- Archive/delete: server routes exist (`POST /v1/sessions/:id/archive`,
  `DELETE /v1/sessions/:id`) — wire buttons on Home rows + session header, TanStack
  mutations, optimistic removal. CLI reaction not required (an archived live session
  keeps running; W2.3 stop is the "end it" path).
- Shell: toasts (sonner), skeletons for Home/timeline initial loads, offline banner
  (`navigator.onLine` + WS state from `apiSocket`), PWA manifest icons
  (192/512 + apple-touch), session title (decrypted) in the timeline header, shadcn
  `Select` replacing native selects, pagination ("Load earlier" button triggering
  `fetchNextPage`).

### [ ] W4.3 (B12) Real setMode for the PTY path

Now that a keystroke seam exists (W1.5), mode switching can be honest: Claude Code's
TUI cycles permission modes with Shift+Tab. Design: `setMode` RPC computes the number
of Shift+Tab presses from `deriveCurrentPermissionMode` state parity with the CLI's
own tracking (the bridge sees `permission_mode` on every hook input — cache the last
seen value), injects `\x1b[Z` × N when **idle and no prompt open** (same gate as
message injection), then verifies via the next hook input's `permission_mode`.
If verification fails, revert the web UI (the RPC returns the observed mode).
This is the one deliberately-keystroke feature — it's a fixed 4-state cycle, not a
freeform widget, and it's verifiable. Keep behind a config flag until soak-tested.

### [ ] W4.4 (A8) Same-directory duplicate session lock

`bootstrap.ts` (`:120-132`): before minting a fresh nonce, take a
`~/.falcon/locks/session-<sha256(machineId|path)>.lock` (the existing lock-file
pattern from `persistence.ts`); if held by a live pid, print the existing session id +
"attach from the web, or run in another directory" and exit 1. Overridable with
`--force-new-session`.

### [ ] W4.5 (A9) Register PTY sessions with the daemon

`start.ts` after bootstrap: call the existing `notifyDaemonSessionStarted`
(`daemon/notify.ts` — built + tested, zero callers) with pid/sessionId/wrapped-DEK so
`falcon doctor`/`falcon kill sessions`/durability see terminal sessions. Best-effort:
daemon absent → log and continue.

### [ ] W4.6 (C21+C22) Usage + compact markers (wire-additive)

- New optional envelope `{ t: "usage", inputTokens, outputTokens, costUsd? }` (additive
  `SessionEventSchema` member) emitted by the mapper from assistant records' `usage`
  field; web renders a per-turn token chip (AI Elements `Context` pattern).
- Compact boundary: emit `{ t: "service", text: "History compacted (/clear)" }` from
  the mapper's `isCompactSummary` branch (`envelopeMapper.ts:480`) instead of dropping.

---

## Testing & verification strategy

- **Per-item:** unit tests named in each item; `pnpm build/typecheck/test/lint` green.
- **Wave 1 exit:** live E2E on the dev stack — the W0.1 checklist plus: web message
  while a local permission prompt is open (must NOT clobber), local typing during a web
  turn (prompt at terminal), kill -TERM the session (web shows "Ended"), interrupt
  mid-turn from web, one web message triggering 5+ read-only tools (zero PermCards
  under W1.1 plan A).
- **Wave 2 exit:** AskUserQuestion from web (single, multi-select, multi-question,
  timeout-fallback), plan approval from web, stop from web.
- **Conformance harness** (`e2e/`): extend the 20-step suite with steps for
  stop-RPC, ended-status, AskUserQuestion answer (bridge-level, fake hook input).
- **Update `docs/pty-continuation-brief.md`** (or retire it into this file) as waves
  land; flip plan.md §17 checkboxes only after live verification, per that file's
  hard-learned false-landing rules.

## Risk register / open questions

1. **`PermissionRequest` hook availability** on our pinned Claude Code — W0.3 decides
   plan A vs plan B for W1.1. (claude-remote-manager ships it in production, so plan A
   is expected.)
2. **Deny-with-answer model behavior** — W0.2. Fallback (plain-text re-ask) is designed
   in and also serves as the timeout path either way.
3. **`scrollToIndex` + dynamic measurement** landing short — known virtualizer quirk;
   the rAF re-call mitigation is standard; verify live.
4. **Shift+Tab mode cycling (W4.3)** is version-coupled TUI behavior — flag-gated,
   verified via hook `permission_mode` echo, last wave.
5. **node-pty spawn-helper exec bit** — the postinstall guard (add to
   `scripts/postinstall.cjs`: chmod `node_modules/.pnpm/node-pty@*/…/prebuilds/*/spawn-helper`,
   Linux no-op) is small; fold into Wave 1 so a fresh `pnpm install` can't break dev
   again.

---

## Master TODO checklist (execution units)

Every task needed to complete this plan, restructured into **execution units** sized
for the dev workflow. Rationale: running the full implement→test→review→verify
pipeline per tiny task is ~95% overhead, and several "small" tasks touch the same
files — running those as parallel worktrees would manufacture merge conflicts. So
tasks are grouped by **file locality**, not by theme.

**Unit kinds** (the workflow script reads these tags):

- `inline` — micro-tasks batched into ONE unit, executed by a single agent in one
  worktree (implement + test + self-review in a single pass). No parallel fan-out.
- `bundle` — co-located tasks that share files; ONE worktree, ONE full pipeline run
  covering all of them, one combined verification.
- `solo` — big/risky tasks that earn the full pipeline on their own.
- `human` — needs the live dev stack and/or the human's terminal; **excluded from the
  workflow**; done interactively (the workflow's task-finder must skip these).

A unit is done only when all its sub-items are checked AND its merge to the target
branch is ancestry-proven (`git merge-base --is-ancestor <tip> <branch>` — the plan.md
§17 false-landing lesson). Work happens on branch `v2-pty-injection` (NOT `main` —
`main` is the pre-PTY ACP state until Phase 5 merges).

### Phase 0 — environment + probes `[human]` *(gate for everything live)*

- [ ] **U0.1 `[human]`** Dev stack up: postgres 5433 → server `:3005`
      (`FALCON_DEV_AUTH=1`) → web `:3000` (`NEXT_PUBLIC_FALCON_DEV_AUTH=1`) →
      `falcon auth login` (fresh boot = old token dead) → daemon restart from the
      env-exported shell → spawn-helper exec bit check
- [ ] **U0.2 `[human]`** (W0.1) Live PTY baseline: TUI renders, typing works, web
      message injects, web-turn PermCard, local-turn terminal prompt; diagnose from
      `~/.falcon/logs/`
- [x] **U0.3 `[human]`** (W0.2) Deny-with-answer probe → **PASS** (2026-07-18,
      claude 2.1.214) — W2.1 primary path confirmed
- [x] **U0.4 `[human]`** (W0.3) `PermissionRequest` hook probe → **PASS, plan A**
      (2026-07-18, claude 2.1.214; stdin shape recorded in the W0.3 section;
      interactive-only — never fires in `-p` mode)

### Phase 1 — core-loop correctness

- [x] **U1.1 `[inline]` "wave1-trivia"** — one agent, one pass
  - [x] P1.0: postinstall spawn-helper chmod guard in `scripts/postinstall.cjs`
  - [x] W1.7a: `ThinkingBlock.tsx` collapsed label → "Thought process"
  - [x] W1.7b: `use-session-ephemerals.ts` 60s staleness cap on `working:true`
  - [x] Combined: scoped tests + `pnpm typecheck` + commit
- [x] **U1.2 `[solo]` "perm-routing"** (W1.1) — the permission-flood rework
  - [x] `hookServer.ts`: forwarder blocking-path widening; PermissionRequest
        schemas/route (204 = no decision); 5th settings entry
  - [x] `pretoolPermissionBridge.ts`: `handlePermissionRequest()` + shared
        `resolve()`/`reset()` across both pending maps; `handlePreToolUse` collapses
        to AskUserQuestion-else-`ask`
  - [x] `remotePermissionHook.ts`: wire `onPermissionRequest`
  - [x] ~~(only if U0.4 failed) plan B~~ — not needed, U0.4 passed; plan A it is.
        Deny copy everywhere must end with "Do not attempt this action another
        way." (probe showed the model working around a deny via allowlisted Bash)
  - [x] Tests: bridge branches ×2 maps, hookServer 204/settings/forwarder
  - [ ] `[human]` live: ≥5-read-only-tool web turn → zero PermCards; genuine prompt →
        one PermCard
- [ ] **U1.3 `[bundle]` "injection-gates"** (W1.2+W1.3+W1.5 — same files:
      `injectionController.ts`, `ptyClaudeSession.ts`, `remotePermissionHook.ts`,
      `pretoolPermissionBridge.ts`, `start.ts`)
  - [ ] W1.2: web-turn watchdog (`WEB_TURN_MAX_MS`) + `markLocalActivity` +
        `isInjecting` getter + `onLocalSubmit` Enter-detection + start.ts wiring
  - [ ] W1.3: `promptOpen`/`localDraft` gates + 120s failsafe + stdin draft
        classification (15s idle) + `setPromptOpen` handle + `onPromptLikely` +
        attention/`tool-end` wiring in start.ts
  - [ ] W1.5: `sendInterrupt()` (ESC) + `interrupt` RPC → real
  - [ ] Tests: watchdog/local-submit; gate matrix + failsafe; ESC write + RPC
  - [ ] `[human]` live: inject-while-prompt-open blocked; draft survives; interrupt
        cancels a turn
- [ ] **U1.4 `[solo]` "lifecycle-status"** (W1.4+B15 — cross-package CLI/SRV/WEB)
  - [ ] `api/sessionStatus.ts` → `reportSessionStatus` (`failed`|`ended`)
  - [ ] Server status route: additive `"ended"` + fan-out
  - [ ] `start.ts`: `reportStatusOnce`, SIGTERM/SIGHUP handlers, exit-code mapping
        (both flows)
  - [ ] Web: Home chip + timeline banner + disabled controls when not `active`
  - [ ] Tests: CLI body/mapping; server enum; web snapshots
  - [ ] `[human]` live: Ctrl-C and `kill -TERM` → web "Ended" in seconds
- [ ] **U1.5 `[bundle]` "timeline-fixes"** (W1.6+W1.8 — `components/timeline/`)
  - [ ] W1.6: `following` state + `scrollToIndex` effect (+rAF re-call) + "Jump to
        latest" + `working` prop + screen pass-through
  - [ ] W1.8: pulse activity row under the list when `working`
  - [ ] Tests: follow/pause/resume behaviors
- [ ] **U1.6 `[bundle]` "web-safety"** (W1.9+W1.10)
  - [ ] W1.9: `RequireAuth` + wrap `/session/[id]`, `/session/[id]/git`,
        `/session/new`
  - [ ] W1.10: `app/error.tsx` + `app/not-found.tsx`; `use-live-render-items`
        `{items,error}` + banner + retry-invalidate
  - [ ] Tests: redirect; boundary; decrypt-fail banner
- [ ] **U1.7 `[human]`** Wave-1 exit: full live checklist ("Testing & verification"
      § Wave 1); `pnpm --filter falcon build` first

### Phase 2 — approved features

- [ ] **U2.1 `[solo]` "askuserquestion"** (W2.1 — CLI+WEB, gated on U0.3+U1.2)
  - [ ] Bridge: `isAskUserQuestion`/`composeAskAnswerReason`/`ASK_FALLBACK_REASON`;
        `handleAskUserQuestion()`; `isQuestion` pending fields; `mapDecision`
        question branch
  - [ ] Web: `parseAskQuestions`; `AskUserQuestionCard` (single/multi/multiSelect,
        `{kind:"allow",scope:"once",updatedInput:{answers}}`, answered/lost-race);
        dispatch in `PermPlaceholder`+`ToolCardShell`; read-only ToolCard + registry
  - [ ] Tests: reason snapshot; bridge branches; card interactions; dispatch
  - [ ] `[human]` live: answer single/multiSelect/multi-question; timeout → plain-text
        re-ask; local widget still mirrors
- [ ] **U2.2 `[bundle]` "session-controls-web"** (W2.2+W2.4 — PermCard/ControlBar/
      screen)
  - [ ] W2.2: ExitPlanMode `planMd` markdown preview + button relabels
  - [ ] W2.4: `deriveCurrentPermissionMode` + pass-through (kill hardcoded
        `"default"`); hide Take-control in PTY mode; hide mode mutation until U4.5
  - [ ] Tests: plan render; selector derivation; visibility rules
- [ ] **U2.3 `[solo]` "stop-session"** (W2.3 — WIRE+CLI+WEB)
  - [ ] Wire: `StopRpcParams/ResultSchema` (additive-lint green)
  - [ ] CLI: `"stop"` in `sessionRpc.ts`; handlers in both flows
        (status-before-kill; `force`)
  - [ ] Web: `sessionRpc.stop` + `stopSession` action + "End session" confirm dialog
  - [ ] Tests: round-trip; ordering; dialog flow
  - [ ] `[human]` live: stop from web → TUI exits, web "Ended"
- [ ] **U2.4 `[human]`** Wave-2 exit: AUQ matrix + plan approval + stop, live

### Phase 3 — coverage & live wiring

- [ ] **U3.1 `[bundle]` "tool-cards"** (W3.1 — `tool-cards/` dir): WebFetch,
      WebSearch, NotebookEdit, LS cards + registry + fixture tests
- [ ] **U3.2 `[bundle]` "mapper-parity"** (W3.2+W3.3 — `envelopeMapper.ts` both)
  - [ ] W3.2: image blocks → `t:"file"` `inline:` refs (≤256KB) else `service` note;
        web `<img>` render for `inline:`
  - [ ] W3.3: static `risk` map on tool-start; `service` envelopes from start.ts
  - [ ] Tests: mapper fixtures (images, risk); web render
- [ ] **U3.3 `[bundle]` "machine-rpc-web"** (W3.4+W3.5 — shared
      `use-machine-crypto.ts`)
  - [ ] `use-machine-crypto.ts` (per-machine DEK unwrap)
  - [ ] W3.4: live machines list + live spawn; swap `new-session-screen` defaults
  - [ ] W3.5: real machineId/worktree into git route; default
        `machineRpcToGitDiffActions`
  - [ ] `[human]` live: spawn from web; git status/diff on a dirty worktree
- [ ] **U3.4 `[bundle]` "home-live"** (W3.6+W3.10 — `features/session-list/`)
  - [ ] W3.6: lazy recent-page decrypt → real status dots; `machine-presence`
        ephemeral replaces 3-min heuristic
  - [ ] W3.10: unmanaged rows live (read-only, actions disabled)
  - [ ] Tests: status derivation fixtures
- [ ] **U3.5 `[solo]` "pty-resume"** (W3.7 — bootstrap/resume, risky)
  - [ ] `bootstrap.ts` `FALCON_RECONNECT_SESSION_ID` re-attach; `start.ts` provider
        id from env; `resumeSession.ts` headless-vs-terminal decision
  - [ ] Tests: re-attach; env consumption
  - [ ] `[human]` live: `falcon resume` continues session + transcript
- [ ] **U3.6 `[bundle]` "tailer-and-loss"** (W3.8+W3.9 — scanner +
      injectionController + start.ts)
  - [ ] W3.8: final `syncNow()` in cleanup; new-file rotation fallback →
        `onNewSession` (debounced, logged)
  - [ ] W3.9: `dispose()` returns dropped queue; submit-skip path too;
        `onDroppedInjections` → claims completed as `dropped-session-ended`
  - [ ] Tests: shutdown tail; rotation; dropped→`duplicate` on retry

### Phase 4 — polish & platform

- [ ] **U4.1 `[inline]` "wave4-trivia"** (W4.1): outbox flush 300→150ms + protocol-doc
      note on the no-streaming decision
- [ ] **U4.2 `[bundle]` "render-polish"** (W4.2a): timestamps + `CopyButton`
      (messages/code/bash) + theme toggle + dual shiki theme (un-hardcode `dark`)
- [ ] **U4.3 `[bundle]` "composer-polish"** (W4.2b): auto-grow + sessionStorage
      drafts + multi-file/image previews + crypto-ready gating + shadcn `Select`
      replacements + "Load earlier" pagination + model selector (spawn) + header
      model chip
- [ ] **U4.4 `[bundle]` "shell-polish"** (W4.2c): toasts + skeletons + offline/WS
      banner + PWA icons/manifest + decrypted title in header + archive/delete
      wiring
- [ ] **U4.5 `[solo]` "pty-setmode"** (W4.3 — flag-gated, version-coupled)
  - [ ] Bridge `permission_mode` cache; `sendModeCycle(n)` gated idle+no-prompt;
        `setMode` RPC verify-via-hook-echo; web re-enable behind flag
  - [ ] `[human]` live soak: 20 switches, no TUI corruption
- [ ] **U4.6 `[bundle]` "session-registration"** (W4.4+W4.5 — bootstrap/start)
  - [ ] W4.4: same-dir duplicate lock + live-pid detection + `--force-new-session`
  - [ ] W4.5: `notifyDaemonSessionStarted` from start.ts (best-effort)
  - [ ] Tests: lock; registration integration
- [ ] **U4.7 `[bundle]` "usage-and-compact"** (W4.6 — WIRE+CLI+WEB): additive
      `t:"usage"` event + mapper emission + compact `service` marker + web token
      chip/divider
- [ ] **U4.8 `[parked]`** Deferred-but-tracked: machine-RPC `stopSession` for
      daemon-spawned sessions; `permission_suggestions` on PermCards; Codex E2E;
      blob storage replacing `inline:` refs

### Phase 5 — landing `[human]`

- [ ] **U5.1** e2e conformance harness re-run (extended: stop/ended/AUQ steps)
- [ ] **U5.2** Docs: CLAUDE.md blurbs; `docs/protocol.md` (stop RPC, ended status,
      usage event); retire `docs/pty-continuation-brief.md` into this file
- [ ] **U5.3** Flip plan.md §17 checkboxes only after live verification
      (false-landing rules)
- [ ] **U5.4** Merge `v2-pty-injection` → `main` once Phases 0–2 live-verified
      (Phases 3–4 may land as follow-ups on main)
