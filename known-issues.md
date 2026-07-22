# Known issues

Tracks issues found during testing, whether still open (why it was parked, what a real fix
needs) or resolved (`~~struck through~~`, what landed and how it was verified).

## ~~Flow 3's spawn-dedup guard doesn't survive a daemon restart~~ — RESOLVED (in worktree, not yet merged)

**Status:** Fixed on a git worktree off `v2-pty-injection` (branch left for the user to merge —
not yet landed on `v2-pty-injection` itself). Full `pnpm build`/`typecheck` clean; the three new
tests and the full `packages/cli` suite pass (the only red is `transcriptIndexer.test.ts`'s
two fs-watch timing tests, which flake under full-suite parallel CPU contention and pass in
isolation — unrelated to this change, which touches nothing on that path).

**Where:** `packages/cli/src/daemon/` — `types.ts` (`TrackedSession.directory`),
`sessionsStore.ts` (`PersistedSession`), `sessionRegistry.ts`, `resumeSession.ts`,
`commands.ts`, `machineIntegration.ts`.

**What was broken:** `FL3.2` ("spawn-directory-dedup") added `TrackedSession.directory` so the
web wizard couldn't spawn two `falcon claude --starting-mode remote` processes in the same
directory (`spawnEngine.ts`'s `scanForLiveSessionInDirectory`, exact-string-equality on
`session.directory === realDirectory`). But that field was **in-memory only**: `PersistedSession`
(`sessions.json`) had no `directory`, so it was never written to disk. On daemon restart,
`resumeSession.ts`'s relaunch called `deps.registry.trackSpawned(launched.pid)` with no directory
(the `ResumeSessionRegistry.trackSpawned(pid)` interface didn't even declare one), so every
session restored after a restart came back with `directory: undefined` and could never dedup-match
again.

**Fix landed (matches the design):**
1. **`sessionsStore.ts`** — added optional `directory?: string` to `PersistedSession` (purely
   additive; a pre-v2 `sessions.json` with no `directory` key still loads fine as `undefined`),
   with a light `typeof` guard in `isPersistedSession`. Bumped `SESSIONS_SCHEMA_VERSION` 1→2 as an
   honest on-disk marker (no migration branch — the read path is version-agnostic and additive,
   documented in a comment).
2. **`sessionRegistry.ts`** — `toPersisted()` and `findResumable()`'s live branch now both carry
   `directory` through (from `session.directory` / `live.directory`).
3. **`resumeSession.ts`** — widened `ResumeSessionRegistry.trackSpawned` to
   `(pid: number, directory?: string)` (the real `SessionRegistry.trackSpawned` already accepted
   the optional second param, so no impl change there) and passed the already-resolved `directory`
   variable through at the relaunch call site.
4. **`resolveResumeDirectory`** — replaced the `() => undefined` stub in **both** `commands.ts`
   and `machineIntegration.ts` with a shared, exported `resolveResumeDirectoryFromRecord`
   (`resumeSession.ts`): re-resolves `session.directory` via `realpath` (`node:fs/promises`,
   matching `workspacePath.ts`'s convention) and returns it, or `undefined` when unset or `realpath`
   throws (directory deleted/unmounted) — failing the resume cleanly rather than guessing. Design
   recommendation followed: re-resolve rather than trust the stored string, since dedup matching is
   exact-string-equality against a freshly-resolved spawn target.

**Deviation from the design:** the design described giving each of the two stubs its own real
implementation; instead a single shared `resolveResumeDirectoryFromRecord` is exported from
`resumeSession.ts` and referenced from both call sites (DRY, identical behavior). No other
deviations. `FL3.2` had already landed the in-memory half (`TrackedSession.directory`,
`trackSpawned(pid, directory?)`, the dedup scan), so this pass only added the durability half.

**Out of scope (deliberately left open):** a still-running session that's never explicitly
resumed after a restart stays invisible to spawn-dedup — that's a separate, still-undesigned
issue and was not touched here.

**Verified:** `pnpm build` + `pnpm typecheck` clean across all packages. New coverage:
`sessionRegistry.test.ts` (end-to-end persist → discard in-memory state → fresh registry →
restore → re-track → `scanForLiveSessionInDirectory` matches again), `resumeSession.test.ts`
(the relaunch calls `trackSpawned` with the resolved directory as its second argument),
`sessionsStore.test.ts` (a `schemaVersion:1` record with no `directory` key loads as
`directory === undefined`, no data loss). Full `packages/cli` suite: 1515/1517 (the 2 reds are
the pre-existing `transcriptIndexer` fs-watch flakes noted above).

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
