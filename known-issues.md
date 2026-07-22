# Known issues

Tracks issues found during testing, whether still open (why it was parked, what a real fix
needs) or resolved (`~~struck through~~`, what landed and how it was verified).

## ~~Flow 3's spawn-dedup guard doesn't survive a daemon restart~~ — RESOLVED (in worktree, not yet merged)

**Status:** Fixed in two passes on a git worktree branched from
`worktree-agent-a762cdc54ca15c830` (commit `812fc36`) — branch left for the user to merge, not
yet landed on `v2-pty-injection`. Full `pnpm build`/`typecheck` clean; new tests and the full
`packages/cli` suite pass (the only red is `transcriptIndexer.test.ts`'s two fs-watch timing
tests, which flake under full-suite parallel CPU contention and pass in isolation — unrelated to
this change, which touches nothing on that path).

**Where:** `packages/cli/src/daemon/` — `types.ts` (`TrackedSession.directory`/`.pid`),
`sessionsStore.ts` (`PersistedSession`), `sessionRegistry.ts`, `readoptSessions.ts` (new),
`resumeSession.ts`, `commands.ts`, `machineIntegration.ts`.

**Pass 1 — persistence half (`812fc36`, already landed before this pass started):** `FL3.2`
("spawn-directory-dedup") added `TrackedSession.directory` so the web wizard couldn't spawn two
`falcon claude --starting-mode remote` processes in the same directory (`spawnEngine.ts`'s
`scanForLiveSessionInDirectory`, exact-string-equality on `session.directory === realDirectory`).
But that field was **in-memory only**: `PersistedSession` (`sessions.json`) had no `directory`, so
it was never written to disk, and every session restored after a restart came back with
`directory: undefined` and could never dedup-match again. Fixed by adding `PersistedSession
.directory?: string` (`SESSIONS_SCHEMA_VERSION` 1→2), threading it through
`toPersisted()`/`findResumable()`, widening `trackSpawned(pid, directory?)`, and replacing the
`resolveResumeDirectory` stub with a real `resolveResumeDirectoryFromRecord` (re-`realpath`s the
stored directory).

**Pass 2 — boot-time re-adoption (this pass), the actual remaining blocker:** Pass 1 alone did
NOT fix the bug end-to-end. `sessionRegistry.ts`'s `restore()` seeds only the durable `resumable`
map from `sessions.json` — it never touches the live `pidToSession` map, and `getSessions()`
(what `scanForLiveSessionInDirectory` scans) returns only `[...pidToSession.values()]`. So after a
daemon restart, a still-running orphaned `falcon claude --starting-mode remote --started-by
daemon` child stayed invisible to spawn-dedup until an explicit `resumeSession` RPC re-tracked
it — and nothing ever triggered that automatically. Resubmitting the web wizard for the same
directory still spawned a genuine duplicate (confirmed live pre-fix: pid then a second, different
pid, both alive, same directory). Fixed by:
1. **`sessionsStore.ts`** — added optional `pid?: number` to `PersistedSession` (purely additive;
   `SESSIONS_SCHEMA_VERSION` 2→3, no migration branch, same reasoning as `directory`'s v2 bump),
   with a `typeof` guard in `isPersistedSession`.
2. **`sessionRegistry.ts`** — `toPersisted()`/`findResumable()`'s live branch now also carry `pid`
   through. New `readoptLiveSessions(probe)` method: runs `readoptSessions.ts`'s matcher over the
   restored `resumable` set and inserts every verified-live candidate straight into `pidToSession`
   (carrying `sessionId`/`encryption`/`directory` so dedup, `stopSession`, and `findResumable` all
   see it) — the durable `resumable` entry is deliberately left in place as a harmless backstop.
3. **`readoptSessions.ts`** (new, pure/testable) — `findLiveOrphanedSessions()`: for each
   persisted record carrying both a `pid` and a `directory`, checks the pid is still alive in a
   real process scan, that its `ps` command line classifies as a falcon `session`
   (`markers.ts`'s `classifyFalconCommand`) — guarding pid recycling, since liveness alone can't
   tell a reused pid from the real thing — and that its resolved cwd `realpath`-matches the
   persisted directory.
4. **`commands.ts`** — `DaemonCommandDeps` gained injectable `listProcesses`/`resolveProcessCwd`
   (defaulting to `processScan.ts`'s real `ps`/`lsof`-backed implementations).
   `runDaemonStartSync` calls `registry.readoptLiveSessions(...)` right after `restore()`, before
   the control server (and any spawn RPC) starts serving.

**Correction to the original bug write-up carried into this pass:** the write-up assumed boot
re-adoption could just "check whether its pid is still alive," but `PersistedSession` never had a
`pid` field — Pass 1 didn't add one, and `resumeSession` relaunches a **new** process rather than
reconnecting, so no pid was ever persisted to check. This pass added the `pid` field for exactly
this purpose (Option A from the design's judgment call, over pure cwd-only process discovery,
since matching by pid is unambiguous and still independently verified against `ps`
classification + cwd rather than trusted blindly).

**Deviations from the design:** none beyond Pass 1's already-recorded one (a single shared
`resolveResumeDirectoryFromRecord` instead of two separate stub implementations).

**Out of scope (deliberately left open):** none remaining for this specific bug — the "still
open" gap this entry's Pass 1 write-up flagged (a live session invisible to spawn-dedup after a
restart) is exactly what Pass 2 closes.

**Verified:** `pnpm build` + `pnpm typecheck` clean across all packages. New/extended coverage:
`readoptSessions.test.ts` (fake-probe unit cases covering pid-dead, pid-recycled-to-a-non-session,
pid-recycled-to-a-different-falcon-process-kind, cwd-unresolvable, wrong-directory,
realpath-symlink-transparency, deleted/unmounted-directory, and multi-candidate independence —
plus a **real-process black-box** `describe` block that spawns an actual child process with a
falcon-session-shaped argv and runs the matcher against the real `processScan.ts`
`listProcesses`/`resolveProcessCwd`, both for the live and post-kill case, since a fake probe
alone proved the wiring but not genuine `ps`/`lsof` discovery — exactly the gap that let Pass 1
look complete while the bug still reproduced live), `sessionRegistry.test.ts` (`readoptLiveSessions`
re-adds a live orphaned session into the live map post-restart without dropping the durable
backstop, and correctly re-adopts nothing for a dead pid), `sessionsStore.test.ts` (`pid`
round-trip, rejects a non-numeric `pid`, and a `schemaVersion:2` record with no `pid` key loads as
`pid === undefined`). Full `packages/cli` suite: 1533/1535 passing (the 2 reds are the
pre-existing `transcriptIndexer` fs-watch flakes noted above, confirmed passing in isolation).

## ~~Recovery code can silently create a disconnected account instead of failing~~ — RESOLVED

**Where:** `docs/bug-fix-plan.md` issue #12 / execution unit `BF3.2` ("recovery-code-restore").
Originally parked on branch `wf/BF3.2` (never merged) because the client-side UI alone couldn't
close the gap — it needed a crypto format change plus a server-side capability that didn't
exist yet. Both landed in this pass.

**What was broken:** `decodeRecoveryCode` (`packages/crypto/src/recovery.ts`) had no
checksum/HMAC tying a code to a real account — it accepted *any* input that happened to decode
to exactly 32 bytes. Combined with `/v1/auth` being upsert-based (never answered "no such
account," only "found or created"), a wrong-but-correctly-shaped recovery code silently minted
a brand-new, empty account instead of failing.

**Fix landed:**
1. **Crypto (`packages/crypto/src/recovery.ts`):** the encoded payload is now
   `masterSecret (32B) || checksum (4B)` — checksum is `sha512(masterSecret).slice(0, 4)` via
   `tweetnacl.hash` (already a dependency, no new one added). `decodeRecoveryCode` recomputes
   and constant-time-compares the checksum, returning `null` on any mismatch — a garbled or
   made-up code now fails client-side, before any network call. Clean wire-format break (no
   real user depended on an old-format code pre-launch), noted plainly in the module doc.
2. **Server (`packages/server/src/app/routes/auth.ts`):** `POST /v1/auth`'s response gained
   `accountStatus: "found" | "created"`, derived from Postgres's `xmax = 0` trick on the
   upsert's `RETURNING` row (no separate pre-check query needed) — purely additive, the normal
   sign-in path is unchanged.
3. **Client (`packages/web/src/app/(public)/signin/`, `lib/restore-recovery-code.ts`):** a
   "restore from recovery code" entry point in the `needs-signup` state. A malformed code
   never touches the network. A well-formed code whose sign-in reports `accountStatus:
   "created"` (i.e. never actually matched a real account) is rolled back (`bridge.clear()`)
   and reported as "no account found," instead of being accepted as a successful restore. This
   is a from-scratch reimplementation of `wf/BF3.2`'s intent (that branch's diff didn't apply
   cleanly after the sign-in page was redesigned), reusing its decode → init → sign-in →
   rollback shape.

**Verified:** fresh `pnpm build`/`typecheck`/`test` all clean across every package
(crypto/server/web/cli), including an exhaustive single-bit-flip test over every position of a
genuine code (every corruption caught by the checksum) and the exact original negative case: a
well-formed-looking but never-issued code now shows an error and leaves no account behind.

## ~~Model-switch service line is clean but invisible in the web timeline~~ — RESOLVED

**Where:** `docs/bug-fix-plan.md` issue #4 / execution unit `BF1.2` ("model-switch-render-fix"),
merged to `v2-pty-injection` (`7a22dde`). Found during the Phase 4 live-verification pass;
fixed same day.

**What was broken:** `/model haiku` in the live TUI produced a genuinely clean `service`
envelope server-side (verified by decryption: `"Set model to Haiku 4.5 and saved as your
default for new sessions"`, no XML tags, no ANSI codes — the CLI-side fix was already correct),
but the web timeline never showed it. A pre-existing filter —
`packages/web/src/components/timeline/transcript-view.ts`'s `isHiddenTimelineItem` —
unconditionally hid every `service`-kind `RenderItem`, clean or not.

**Fix landed:** added a `quiet: boolean` field to `ServiceItem`
(`packages/web/src/sync/reducer/types.ts`), computed by the reducer via a small
`ROUTINE_SERVICE_TEXTS` allowlist (`reduce.ts` — today just `"session started"`; everything
else, including model-switch confirmations, compaction notices, omitted-attachment notes, and
remote-session errors, is `quiet: false`). `transcript-view.ts`'s `isHiddenTimelineItem` now
only hides `service` items where `quiet` is true.

While fixing this, found and fixed a **second layer of the same bug**: `RenderItemGroups.tsx`'s
own `isMessageGroupItem` allowlist didn't include `"service"` at all, so a visible service item
would have still been silently dropped before ever reaching `TimelineRow`. `service` is now a
`StandaloneGroupItem` (alongside `subagent-group`), rendered as its own row between messages via
`ServiceLine` — appropriate since these items often carry no `turn` and aren't part of an
adjacent message bubble's content.

**Verified:** fresh `pnpm build`/`typecheck`/`test` all clean (1481 tests). New coverage in
`reduce.test.ts`, `transcript-view.test.ts`, and `RenderItemGroups.test.ts` (including the
standalone-grouping behavior); the `trace_dedupe_and_reorder.json` golden fixture was updated
for the new field.

## ~~TaskCreate/TaskUpdate render as raw JSON instead of a checklist card~~ — RESOLVED

**Where:** `docs/bug-fix-plan.md` issue #7 / execution unit `BF2.1` ("plan-and-task-cards").
Originally left unfixed on purpose: the investigating agent refused to build a card from a
guessed schema, since nobody had ever captured what `TaskCreate`/`TaskUpdate` (Claude Code's
current task/checklist tool pair, replacing the older `TodoWrite`) actually look like on the
wire in this codebase. Verified and fixed via a dedicated subagent pass.

**What was broken:** `TaskCreate`/`TaskUpdate` had no entry in the web tool-card registry
(`packages/web/src/components/timeline/tool-cards/registry.tsx`), so both fell through to the
generic raw-JSON `McpGenericCard` fallback.

**Real shape, captured not guessed:** a genuine prior Claude Code session transcript on this
machine (this repo's own history) was found and trimmed into
`packages/cli/src/claude/__fixtures__/task-create-update-session.jsonl`. Confirmed: `TaskCreate`
args are `{subject, description, activeForm}` — one call creates exactly one task.
`TaskUpdate` args are a **partial patch by id** (`{taskId, status}` most commonly; also seen
patching `subject`/`description`/`activeForm`, and an older `task_id` snake_case spelling) —
never the full list. Tool-end `output` is a plain confirmation string (e.g. `"Task #1 created
successfully: ..."`); the richer `{success, taskId, updatedFields, statusChange}` object Claude
Code also writes lives only in its own `toolUseResult` field, which `envelopeMapper.ts` never
reads (confirmed generic passthrough, pinned with a new `envelopeMapper.test.ts` case).

**Fix landed:** `parseTaskCreateArgs`/`parseTaskUpdateArgs` in `packages/web/src/lib/
tool-args.ts` (dual `taskId`/`task_id` tolerance); a new `TaskEntryCard.tsx` (sibling of
`TodoCard`) registered for both tool names. Renders each call as its own standalone entry
(heading + status indicator + optional description) rather than a cumulative checklist —
documented why: `TaskUpdate` never carries the full list and a `ToolItem` has no access to
sibling calls in the same session to reconstruct one; a persistent live checklist would need
folding at the reducer level across the whole session, out of scope here.

**Verified:** fresh `pnpm build`/`typecheck`/`test` all clean (1482 tests, worktree-isolated
implementation independently re-verified — fixture re-inspected by hand, all new tests re-run
outside the implementing agent — before merging into the working tree). New coverage in
`tool-args.test.ts`, `TaskEntryCard.test.ts`, `registry.test.ts`, and `envelopeMapper.test.ts`.

## ~~Permission-mode web sync misses a session's very first mode~~ — RESOLVED

**Where:** `docs/bug-fix-plan.md` issue #5 / execution unit `BF1.3` ("permission-mode-sync"),
merged to `v2-pty-injection` (`a107aeb`). Found during the Phase 4 live-verification pass;
fixed same day.

**What was broken:** `pretoolPermissionBridge.ts`'s `cachePermissionMode` never emitted a
`permission-mode` event for the very first mode a hook ever reported in a session
(`lastPermissionMode` started `null`, and the emit condition required
`this.lastPermissionMode !== null`). If a user switched mode via Shift+Tab *before* their first
tool call, that first hook call reported the already-switched mode as if it had always been
that way — no transition was ever recorded, so the web chip stayed stuck on "Default" until an
unrelated second switch.

**Fix landed:** new `extractPermissionModeFlag()`
(`packages/cli/src/session/permissionModeFlag.ts`, mirrors the existing `extractModelFlag()`
pattern) reads a `--permission-mode` passthrough flag from `falcon claude`'s args. `start.ts`'s
`runLocalPty()` now passes `extractPermissionModeFlag(claudeArgs) ?? "default"` as a new
`initialPermissionMode` option, threaded through `remotePermissionHook.ts` into
`PreToolPermissionBridge`'s constructor, which seeds `lastPermissionMode` from it instead of
always starting at `null`. The very first hook echo now has a real baseline to diff against, so
a pre-first-tool-call Shift+Tab is a genuine, emittable transition. A caller that doesn't
provide `initialPermissionMode` (any untouched call site) keeps the exact old behavior — the
seed is opt-in, not a forced default.

**Verified:** fresh `pnpm build`/`typecheck`/`test` all clean (1481 tests). New coverage in
`pretoolPermissionBridge.test.ts` (seeded-baseline emit/no-emit cases, plus a check that the
unseeded path is unchanged), `permissionModeFlag.test.ts`, and `start.test.ts` (confirms the
flag threads through end-to-end, and the `"default"` fallback when absent).

## ~~OfflineBanner shows a misleading "Reconnecting…" on pages with no connection to reconnect~~ — RESOLVED

**Where:** `docs/bug-fix-plan.md` issues #9/#10 / execution unit `BF3.1`
("jwt-expiry-and-reconnect"), merged to `v2-pty-injection` (`3d0d54a`). Found during the Phase 4
live-verification pass; fixed same day.

**What was broken:** the globally-mounted `OfflineBanner` (in `app/providers.tsx`, wrapping
every route including public ones) showed the generic "Reconnecting to Falcon…" message
indefinitely on `/signin/` itself, which was misleading — nothing was trying to reconnect
there. Root cause: `apiSocket.connect()` is only ever called from `use-sync-snapshot.ts`, which
only mounts inside authenticated screens, so on `/signin/` `wsConnected` stayed at its default
`false` forever with no connection ever attempted.

**Fix landed:** moved `<OfflineBanner />` out of the global `app/providers.tsx` (option (a) from
the original real-fix plan) into `app/(protected)/layout.tsx`, inside `RequireAuth` — it now
only ever mounts on authenticated screens, where `apiSocket.connect()` is actually called and
`wsConnected`/`authExpired` reflect something real. It never renders on `/signin/`, `/pair/`, or
`/auth/callback/*` anymore, since there's nothing meaningful for it to report there.

**Verified:** fresh `pnpm build`/`typecheck`/`test` all clean (741 web tests). Confirmed live in
the browser: cleared the crypto identity (IndexedDB) to force the `needs-signup` state on
`/signin/` — no banner appears, while the sign-in form (including the recovery-code restore
option) renders normally. New source-wiring tests (same technique as `signin/page.test.ts`,
since `RequireAuth`'s `useRouter()` can't run under this package's DOM-less vitest config):
`(protected)/layout.test.ts` confirms the banner mounts inside `RequireAuth`, before `AppShell`;
`providers.test.ts` confirms it's no longer wired globally.
