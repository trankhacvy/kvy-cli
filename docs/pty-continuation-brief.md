# Continuation brief: Falcon PTY-injection + remote-control UX

Paste the prompt at the bottom into a new session. Read this whole file first, then
`CLAUDE.md`, `falcon-system-design.md` (v0.3 = ACP), and `plan.md` §17. Don't trust this
brief for implementation detail — only for the narrative of how we got here and what's next.

Falcon = E2E-encrypted "mission control" for coding-agent sessions (wraps Claude Code /
Codex, mirrors sessions to a web/mobile dashboard, lets you steer them remotely).

## Repo state (as of this brief)

- **`main`** (commit `971832f`): the **v2 ACP migration is complete** (plan.md §17 Phases
  2.0–2.4 all checked). Remote/headless provider comms run over the **Agent Client Protocol**
  via the official adapters (`@agentclientprotocol/claude-agent-acp`, `codex-acp`), replacing
  the old Claude Agent SDK integration and the hand-rolled Codex app-server client. All
  packages build/typecheck/test/lint green; the ACP contract test passed **live**. Tag
  **`v1`** = pre-ACP rollback anchor.
- **`v2-pty-injection`** (commit `4998671`, NOT merged to main): the current work — see below.
  build/typecheck/**1215 tests**/lint green, but **not yet fully live-tested**.

## Why the PTY branch exists (the core UX problem it fixes)

The v1/v2 design had a **local↔remote mode switch**: local mode ran the real `claude` TUI
with `stdio: inherit` (observe-only via the transcript tailer); to accept a web message it
**killed the TUI and took over headlessly** (ACP/SDK) with an Ink "remote mode" status view.
The user's #1 complaint: that takeover makes the terminal unusable — you can't type or use
slash commands. Claude Code's own `/remote-control` keeps the normal TUI and just streams
remote messages in; we want that.

**Root cause:** `stdio: inherit` can only *observe* the child — it can't *inject* input, so
the only way to deliver a web message was kill-and-take-over. The fix is to run `claude` in a
**PTY** and inject web messages into its stdin (the omnara model). One process, normal TUI
always, no mode switch.

## What the `v2-pty-injection` branch does

**Terminal `falcon claude` (default) → new PTY-injection model:**
- `claude/ptyClaudeSession.ts` — spawns `claude` on a `node-pty` pseudo-terminal (normal TUI
  always); real stdin passes through (typing/slash-commands unchanged); PTY output → stdout;
  resize propagated. Transcript tailer still mirrors to web, unchanged.
- `claude/injectionController.ts` — gates web-message injection: types the message into the
  PTY only when idle (250ms submit delay + post-submit cooldown); queues if mid-turn.
- `claude/ptyFetchSignal.ts` — receives the launcher's `fetch-start`/`fetch-end` idle signal
  over a unix socket (a PTY child has no fd 3), debounced into a busy/idle edge.
- `scripts/falcon_claude_launcher.cjs` — when `FALCON_FETCH_SIGNAL_PATH` is set, writes the
  fetch signal to that socket instead of fd 3 (fd 3 still the default).

**Remote permissions without a takeover → PreToolUse hook:**
- `claude/remotePermissionHook.ts` (`installRemotePermissionHook()`) — owns ALL FOUR Claude
  Code hooks (SessionStart/Notification/Stop/PreToolUse) on ONE loopback hook server; exposes
  `settingsEnv`/`settingsPath` (the `--settings` file), `resolvePermission`,
  `markWebTurnStart`/`markTurnEnd`.
- `claude/pretoolPermissionBridge.ts` — routes a pending tool call through the existing
  perm-request/`perm.answer`/perm-resolve pipeline, first-wins, timeout→deny. **Only routes
  to the web for WEB-INITIATED turns** (a locally-typed turn returns `ask` instantly → normal
  terminal prompt, zero added latency). Verified the real Claude Code 2.1.212 PreToolUse hook
  JSON contract: stdin `{session_id, tool_name, tool_input, permission_mode, ...}` → stdout
  `{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"allow"|"deny"|"ask",
  permissionDecisionReason}, suppressOutput:true}`.

**Wiring (verified by reading the merged code):** `commands/start.ts` forks on
`detectStartingMode`: `runLocalPty()` (terminal) installs ONE `installRemotePermissionHook`,
starts the PTY session with the hook's `settingsPath`/`settingsEnv` (so all four hooks fire),
marks the web turn on inject (`onInjected` → `markWebTurnStart`), routes `perm.answer` →
`permHook.resolvePermission`, and completes the §7.10 send-claim on inject. `runRemoteLoop()`
(`--starting-mode remote`, daemon-spawned, no terminal) keeps the ACP `loop()` path unchanged
— ACP owns permissions agent-side there. The ACP work from Phases 2.0–2.4 is untouched.

**How it was built:** two parallel worktree-isolated agents (PTY input path; PreToolUse
permissions) + a reconciliation agent that merged them into one hook server + one `start.ts`.
Verified independently: build/typecheck/1215 tests/lint green.

## CRITICAL live-test blocker we hit and fixed (must make permanent)

`falcon claude` failed with `[pty-session] setup failed: posix_spawnp failed.` — on the REAL
terminal, not just the sandbox. **Cause:** pnpm's content-addressable store strips the
execute bit off node-pty's prebuilt `spawn-helper`, so `pty.fork()` can't exec it. **Manual
fix applied to the current node_modules** (not committed):
```
chmod +x node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/prebuilds/*/spawn-helper
```
This survives until the next `pnpm install`, which re-strips it. **TODO: add a permanent
postinstall guard** (chmod the spawn-helper; handle Linux, where node-pty compiles from
source and the path differs). The helper is unsigned + only `com.apple.provenance` xattr —
fine for local dev; the exec bit was the whole problem.

After the chmod, the user was about to retry — **the real PTY spawn + TUI render is still
UNCONFIRMED**. First job in the new session: confirm `falcon claude` brings up the normal
Claude TUI and that a web message injects into it without takeover.

## Open problems (in priority order)

1. **AskUserQuestion (and other interactive TUI widgets) are unsolved in the PTY model.**
   This is a genuine architectural fork, researched this session:
   - When Claude calls AskUserQuestion, the options DO reach the web as a generic `tool-start`
     envelope (raw args), but the web has no selectable card for it (not in the ToolCard
     registry → generic fallback), and there's **no way to answer it from the web**.
   - The PreToolUse hook can't help: it returns allow/deny/ask, it can't supply the user's
     *choice*.
   - Reference codebases: **happy** handles it cleanly (dedicated selectable
     `AskUserQuestionView.tsx`, answered via its `sessionAllow`/permission-allow op) BUT only
     because it's **headless SDK** — AskUserQuestion arrives as a `canUseTool` callback with
     the answer as `updatedInput`; happy has no real TUI. **mobvibe** (ACP) doesn't handle it
     (ACP disables AskUserQuestion without form-elicitation). **omnara** (PTY) has no
     structured handling — only whatever its terminal screen-scraping catches.
   - The tradeoff: **the PTY model that gives the great TUI is exactly the model where
     interactive widgets (AskUserQuestion, ExitPlanMode, permission-*choice*) are hardest.**
     Clean structured answering needs a headless/`canUseTool` channel the PTY path doesn't
     have. Answering from web in PTY = inject the choice as keystrokes into the TUI widget
     (omnara-style, fragile) OR route those turns through the headless path. **Decide this
     deliberately before building.** happy's `AskUserQuestionView` UI is worth stealing; the
     answer path is the open question.

2. **Smaller web-UI bugs (user-reported, separate from the CLI):**
   - Timeline does not auto-scroll to bottom on new items.
   - "Thinking…" indicator stays displayed after the message already rendered (working/
     activity ephemeral or turn-not-closed in the reducer not cleared on turn-end).
   - Tool-call / loading messages aren't rendered in the web timeline over the PTY path —
     trace whether the tailer emits tool-start/tool-end envelopes for injected turns and
     whether the timeline's live reducer wiring renders them (the ToolCard registry exists;
     the live data wiring may not).

3. **Permanent node-pty spawn-helper chmod postinstall guard** (see above).

4. **If the PTY branch checks out live, merge `v2-pty-injection` → `main`.** Until then, main
   stays at the known-good ACP state.

## How the web actually receives data (so #2 is traced correctly)

Not raw WS parsing. The CLI transcript tailer maps Claude's JSONL → encrypted
`SessionEnvelope[]` batches → `POST /v1/sessions/:id/messages` (disk-backed outbox) → server
fans out `message-new` over the user WS. The web decrypts in a crypto Web Worker and folds
`SessionEnvelope[]` through the **reducer** (`packages/web/src/sync/reducer/`) into
`RenderItem[]` (tool-start/end → ToolCard, thinking, turn markers). Correctness is
TanStack-Query-recoverable; WS is the latency path. So "tool-calls not rendering" is a
mapping/wiring gap (tailer envelope emission or reducer/timeline live-wiring), not a parser.

## Dev environment + the gotchas we hit (save yourself the pain)

- Postgres: Docker container `falcon-postgres`, port **5433** (5432 taken by native pg).
- Server: `DATABASE_URL=postgres://falcon:falcon@localhost:5433/falcon FALCON_DEV_AUTH=1
  pnpm --filter @falcon/server dev` → `:3005`.
- Web: `NEXT_PUBLIC_FALCON_DEV_AUTH=1 pnpm --filter @falcon/web dev` → `:3000`. **The
  "Continue without OAuth (dev only)" login button only renders when the web was started with
  `NEXT_PUBLIC_FALCON_DEV_AUTH=1`.**
- CLI: run every `falcon` command with `FALCON_BACKEND_URL=http://localhost:3005
  FALCON_FRONTEND_URL=http://localhost:3000` exported.
- **Daemon registration gotcha (cost us several rounds):** the daemon registers its machine
  against whatever `FALCON_BACKEND_URL` the shell that *starts* it carries. If it auto-starts
  from a shell without the var, it registers against prod, never gets a `machineId`, and
  `falcon claude` says "this machine hasn't finished registering." Fix: export the vars, then
  `falcon daemon stop && falcon daemon start` from that shell.
- **Auth token doesn't survive a server restart** (dev server signs with a per-boot secret):
  after restarting the server you get `HTTP 401` on machine register → no machineId. Fix:
  re-run `falcon auth login` against the running server, then restart the daemon.
- **`bin/falcon.mjs` runs `dist/`**, not source → `pnpm --filter falcon build` after every
  CLI change. Logs are file-only in `~/.falcon/logs/` (never stdout — would corrupt the TUI).

## Reference codebases at repo root (gitignored, read-only)

`happy/` (MIT, SDK mode-switch model, the primary reference), `mobvibe/` (ACP), `omnara/`
(Python, PTY screen-scrape), `superset/`. For AskUserQuestion specifically:
`happy/packages/happy-app/sources/components/tools/views/AskUserQuestionView.tsx`.

## Suggested first steps in the new session

1. Confirm the node-pty spawn-helper still has +x (`ls -l
   node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`);
   re-chmod if a `pnpm install` happened. Add the permanent postinstall guard.
2. Live-test `falcon claude` on `v2-pty-injection`: normal TUI renders, typing works, a web
   message injects without takeover, a web-initiated tool routes a PermCard to the web, a
   locally-typed tool prompts instantly at the terminal.
3. Fix the smaller web bugs (#2) — likely quick wins that make the mirror look right.
4. Bring the AskUserQuestion architectural fork (#1) to the user with a recommendation before
   building — don't just pick a path.
5. Merge `v2-pty-injection` → main once live-verified.
