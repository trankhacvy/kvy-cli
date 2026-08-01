# Codex end-to-end test checklist

Real-CLI, real-web, real-Codex-CLI test plan for `kvy codex` — the manual runbook
CLAUDE.md's "Testing the app end-to-end" section describes for `kvy claude`, extended
for Codex's very different architecture. Not unit tests, not mocked e2e — this is the
"drive the actual product like a user would" checklist, written after a full code read of
the Codex path (`packages/cli/src/commands/startCodex.ts`, `packages/cli/src/codex/`,
`packages/cli/src/acp/{acpRemote,acpConnection,acpToEnvelope,acpPermissionHandler}.ts`,
`packages/cli/src/daemon/spawnEngine.ts`, and the web-side gates in
`packages/web/src/components/timeline/{mode,model}-switch-state.ts` and
`packages/web/src/features/session-control/session-state.ts`).

**Status (2026-07-31): all four ⚠ items below were confirmed as real gaps by a live run,
then fixed and live-re-verified against `docs/multi-agent-provider-abstraction-plan.md`'s
Phases 1, 6, 7, and 8.** The ⚠ markers are left in place with a resolution note under each,
rather than deleted, so the "what broke and how it was proven fixed" trail survives — see
`docs/known-issues.md` for the corresponding issue-tracker entries.

## Why Codex needs its own plan, not a rerun of the Claude runbook

| | Claude (`kvy claude`) | Codex (`kvy codex`) |
|---|---|---|
| Transport | Local PTY (real terminal) + separate ACP remote path | ACP only, always — `codex app-server` has no local TUI |
| Control model | Local↔remote handoff loop, emits `mode-switch` envelopes | Remote for its entire life, **never emits `mode-switch`** |
| `workspaceId` | Registered (known-issues.md #6, fixed for Claude) | **Fixed** — now registered for codex too (Phase 1, `registerSessionWorkspace.ts`) |
| Mode switch | PTY-gated, off by default (known-issues.md #11) | **Fixed** — real ids mapped via `CODEX_MODE_ID_BY_PERMISSION_MODE`, live-verified working (Phase 6) |
| Model switch | PTY `/model` injection | Honestly `{ok:false}` — no ACP equivalent (unchanged, correct as-is) |
| Take control | Real local handoff | Honestly `{ok:false}` — meaningless here (unchanged, correct as-is) |
| Resume/continue | `--resume <id>` composed from `providerSessionId` | **Fixed** — `--continue-from` now threads into `session/load` when the adapter supports it (Phase 7), live-verified with a real secret-recall test |
| Plan/todo list | Rendered from `TodoWrite` | **Fixed** — ACP `plan` now mapped to a wire `plan` event and rendered as a live-updating checklist (Phase 8) |

## 0. Environment setup

- [ ] `codex --version` works on PATH (real install: `npm install -g @openai/codex` or the
      brew cask) and you're logged into Codex itself (`codex login` / `OPENAI_API_KEY`)
      outside Kvy.
- [ ] Delete/rename `~/.kvy/adapters` (or use a fresh `KVY_HOME_DIR`) once, then run
      `kvy codex` — confirm the `@agentclientprotocol/codex-acp@1.1.4` adapter
      auto-installs (pinned version + integrity hash in `adapters/manifest.ts`) rather than
      silently failing.
- [ ] Uninstall the Codex CLI temporarily, run `kvy codex` — expect the exact
      `CODEX_NOT_INSTALLED_MESSAGE` (install instructions), exit code 1, not a stack trace.
- [ ] `kvy doctor` reports Codex adapter health correctly (installed/version/integrity).

## 1. Starting a local `kvy codex` session

- [ ] `kvy codex` in a real project dir prints the honest `CODEX_NO_LOCAL_MODE_NOTE`
      ("no local terminal mode... driven remotely from the start") — confirm this actually
      appears, not just in source.
- [ ] Session appears on web Home within a few seconds, title = directory basename.
- [ ] `kvy codex --model <alias>` — confirm `extractModelFlag` actually threads the
      model into session metadata and it displays correctly on web (chip shows the real
      model, not "Model unknown").
- [ ] `kvy codex -b <branch>` — worktree gets created via the shared
      `ensureBranchWorkspace` (`index.ts`), same as Claude's local worktree-parity path.
      Confirm the codex session actually starts inside that worktree, not the bare repo.

## 2. ⚠ Issue #6 — `workspaceId` gap — ✅ FIXED, live-verified

Confirmed the full blast radius live, before and after the fix:

- [x] Before the fix: git diff / Repo files / Checks / timeline file references all showed
      "no machine/workspace recorded" for a live codex session
      (`SessionGitScreen.tsx`/`SessionFilesScreen.tsx`/`SessionChecksScreen.tsx`/
      `SessionTimelineScreen.tsx`), confirming the gap was real, not theoretical.
- [x] Fix: `registerSessionWorkspace()` (new, `packages/cli/src/session/
      registerSessionWorkspace.ts`) is now called from `startCodex.ts`, same as Claude's
      launch path.
- [x] After the fix: re-ran all four screens against a fresh live codex session — all four
      now resolve exactly as they already did for a Claude session.

## 3. Messaging / turn lifecycle

- [ ] Send a message from web to a live codex session — arrives in real Codex, response
      streams back as `text` envelopes.
- [ ] Text coalescing: multiple `agent_message_chunk`s render as one flowing message, not
      fragmented bubbles.
- [ ] Reasoning/thinking: does codex-acp emit `agent_thought_chunk`? If so, confirm it
      renders as a distinct "thinking" block on web (`text{thinking:true}`).
- [ ] Tool calls: exec and file-edit tool calls render as `tool-start` → `tool-end`, with
      only a start/end lifecycle (no intermediate "running" state — ACP has none; confirm
      the UI doesn't imply one it can't back up).
- [ ] Interrupt mid-turn from web — `session/cancel` fires, turn ends with
      `stopReason: cancelled`, no hang, no phantom "still running" state left on web.
- [ ] Send-idempotency: kill the web tab mid-send, reopen — confirm the message isn't
      duplicated (claim store) and isn't silently lost (`outcome-unknown` path).

## 4. ⚠ Plan/todo rendering — ✅ FIXED, live-verified

`acpToEnvelope.ts` used to drop `plan` entirely (no wire schema equivalent) with just a
log line — confirmed live that it silently vanished before the fix.

- [x] Gave Codex a 4-step task with an explicit instruction to use its plan tool.
- [x] Before the fix: confirmed on web there was no task/plan UI at all — it silently
      vanished, a real UX gap distinct from #6.
- [x] Fix: `acpToEnvelope.ts` now maps ACP `plan` (verified against the installed
      `codex-acp` package's actual emitted shape) to a new wire `plan` event; the web
      reducer and `RenderItemGroups.tsx` render it as a `PlanChecklist` card.
- [x] After the fix: re-ran the same 4-step task — the plan checklist rendered as its own
      card, updating live through multiple snapshots (steps pending → in_progress →
      completed with strikethrough), ending fully checked off.

## 5. Permission approvals (exec / patch)

Unified path — same `AcpPermissionHandler` Claude's remote mode uses, so this should
genuinely work:

- [ ] Trigger a real exec approval (e.g. ask Codex to run a shell command) — confirm the
      PermCard appears on web with correct labels.
- [ ] Approve once (`allow_once`) — command runs, one-time only, a repeat asks again.
- [ ] Approve always (`allow_always`) — subsequent identical calls auto-approve for the
      rest of the session.
- [ ] Deny — Codex sees the rejection and adapts (doesn't hang, doesn't silently retry).
- [ ] Trigger a file-patch approval (edit request) — same approve/deny paths, and confirm
      the diff shown in the card matches the real proposed patch.
- [ ] Answer from two browser tabs at once — confirm first-wins, second gets
      `already-answered`.
- [ ] `updatedInput` degradation: if you try to edit the proposed command/patch before
      approving (if the UI even offers that for codex), confirm it falls back to a plain
      allow with a warn log rather than silently applying your edit (ACP can't carry
      `updatedInput`).

## 6. ⚠ Mode switching — ✅ FIXED, live-verified

`deriveControlMode` used to default every session to `"local"` and only flip to
`"remote"` on a `mode-switch` envelope — which only Claude's PTY launchers emitted, so
codex's mode selector was misclassified and effectively dead.

- [x] Before the fix: confirmed live the mode selector was greyed out for a codex session,
      for the wrong reason — codex was never "local" in the PTY sense, just misclassified.
- [x] Fix: capability-gated via `PROVIDER_CAPABILITIES` (`supportsLiveModeSwitch`) instead
      of the PTY-only `mode-switch` envelope check, and `acpRemote.ts` now maps wire
      `PermissionMode` values to the installed `codex-acp` adapter's real mode ids
      (`read-only`/`agent`/`agent-full-access`, verified by reading its compiled source)
      via `CODEX_MODE_ID_BY_PERMISSION_MODE`.
- [x] After the fix: mode switching (`default`/`acceptEdits`/`plan`/`bypassPermissions`)
      confirmed live to actually take effect in the real Codex agent, with no JSON-RPC
      "Invalid params" errors (the original failure mode this fix resolved).

## 7. Model switching (expected honest no-op)

- [ ] Confirm the model selector **never appears** for a codex session (`canMutateModel`
      is unconditionally false for `controlMode === "remote"`), not that it appears and
      silently fails.
- [ ] If somehow reachable, confirm `setModel` returns `{ok:false}` cleanly with no UI
      hang.

## 8. Take control (expected honest no-op)

- [ ] Confirm no "take control" button ever renders for a codex session
      (`shouldShowTakeControl` requires `controlMode === "remote"`, which per §6 above
      codex may never even reach on web — so this is doubly gated; confirm behavior is
      still graceful either way).

## 9. Stop / end session

- [ ] Stop from web (non-force) — `requestExit()` fires, CLI process exits 0,
      `remote.stop()` cleans up the ACP child, session shows ended on web.
- [ ] Force-stop from web — confirm the 3s grace `process.exit(0)` timer actually fires if
      the graceful path hangs.
- [ ] Ctrl-C in the local terminal — same clean shutdown path (`waitForSigint`).
- [ ] Archive a codex session afterward (clean and dirty-worktree cases) — confirm the
      archive-session flow (`archive-session-runner.tsx`) behaves identically for a
      codex-originated worktree.

## 10. ⚠ Resume / continue-from-web / crash recovery — ✅ FIXED, live-verified

`spawnEngine.ts`'s `buildProviderArgs` pushes `--continue-from <providerSessionId>` onto
the respawned argv for any provider, but `startCodex.ts` used to never read that flag or
pass a `resume` value into `startAcpRemote(...)`.

- [x] Fix: `startCodex.ts` now reads `--continue-from` (`continueFromFlag.ts`) and
      `acpRemote.ts`'s `ready` path calls `connection.loadSession(...)` (real ACP
      `session/load`) when the adapter reports `agentCapabilities.loadSession: true`,
      falling back to `createSession` otherwise.
- [x] Live-verified with a definitive, airtight test: told a fresh session a secret code,
      killed the process, resumed a brand-new Kvy session row via
      `--continue-from <real-acp-id>`, and confirmed the secret code was correctly
      recalled — with zero Kvy-side transcript history available to have leaked it
      from, proving the underlying Codex conversation was genuinely resumed, not just a
      directory re-attach.
- [x] `PROVIDER_CAPABILITIES.codex.supportsResume` flipped from `false` to verified-`true`.
- [x] Crash recovery: confirmed `resumeSession.ts`'s relaunch restarts cleanly with no
      zombie state or daemon crash loop.

## 11. Concurrency / auth (issue #20 territory, codex-specific angle)

Codex shares the exact same `TokenProvider`/`credentialsLock.ts` machinery via
`startCodex.ts`'s preflight.

- [ ] Run a codex session and a claude session simultaneously against the same
      account/machine — force a refresh race (timing-compression technique: temporarily
      shrink `ACCESS_TOKEN_TTL_SECONDS`/`GRACE_MS`/`REFRESH_SKEW_MS`, revert after) —
      confirm no false "needs re-authentication" for either.
- [ ] Two concurrent codex sessions on the same machine — same check.

## 12. Directory dedup / spawn

- [ ] Spawn a codex session from web into a directory that already has a live codex
      session — confirm `scanForLiveSessionInDirectory` dedup reuses/reports the existing
      one instead of double-spawning.

## 13. Settings / provider accounts

- [ ] Settings → Providers shows Codex as installed/"authenticated" purely mirroring
      `installed` (no real credential check exists) — confirm the copy doesn't overclaim
      ("authenticated" when Kvy genuinely can't verify that).
- [ ] New-session wizard: Codex option shows the beta banner ("no local TUI attach,
      feature parity may lag") — confirm it's visible and accurate, not stale copy.
