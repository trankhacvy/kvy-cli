# BF0.1 — scanner-hook-gating

**Section:** docs/bug-fix-plan.md #1 [CRITICAL] Cross-session content leak via the
directory-wide fallback watcher.

`docs/bug-fix-plan.md` is untracked in the repo (present in the main worktree's working
tree but never committed), so it wasn't visible from this worktree's checkout. Read
directly off disk from the main worktree's copy before starting.

## Root cause (recap)

`packages/cli/src/claude/scanner.ts`'s directory-wide rotation fallback
(`watchProjectDirectoryForNewSessions`) treated *any* new `*.jsonl` file appearing in the
shared Claude Code project transcript directory as proof its own tracked session rotated,
with no correlation check against the actual child process. Once a tracked session was
dropped (`onGaveUp` / `deadSessions`), the next unrelated sibling session's transcript file
to appear — from a totally different terminal sharing the same cwd — got silently adopted,
and the tailer began forwarding that session's real messages under the wrong session's
identity. Confirmed live via server-side ciphertext decryption.

## What changed (`packages/cli/src/claude/scanner.ts`)

1. **`hookConfirmed` flag.** Seeded `let hookConfirmed = opts.sessionId !== null` (an
   already-known session id at construction came from an authoritative source too — an
   explicit `--resume`/reconnect, not the directory heuristic). Flipped to `true` only
   inside the object `createSessionScanner` returns, in the public `onNewSession` entry
   point — the sole caller-driven ("hook") path:
   ```ts
   onNewSession: async (sessionId, options) => {
     hookConfirmed = true;
     await announceNewSession(sessionId, options, "hook");
   },
   ```

2. **Directory-watcher callback gated on it.** Once `hookConfirmed` is true, the fallback
   callback never calls `announceNewSession` for a file that isn't `currentSessionId` —
   it logs at `debug` ("ignoring unrelated new transcript file (hook coverage active)") and
   returns instead of adopting it.

3. **`announceNewSession` revival split by `source`.** Added a third parameter,
   `source: "hook" | "fallback" = "hook"`. The `deadSessions.delete(sessionId)` revival
   branch now only runs when `source === "hook"` — a fallback-sourced call (zero actual
   correlation to "this is my own process rotating") can never resurrect a previously
   dropped session id. The directory-watcher callback's `announceNewSession` call now
   explicitly passes `"fallback"`.

4. **`FALLBACK_ARMED_WINDOW_MS` time-box.** A module constant (30s default) plus a
   `fallbackArmedUntil` timestamp, initialized to `Date.now() + fallbackArmedWindowMs` at
   scanner start and re-armed (same window) inside `onGaveUp` — a drop is exactly the
   moment a legitimate rotation is plausible, so re-arming there (rather than leaving the
   window permanently expired for the rest of the session) matches the plan's "and again
   briefly after an `onGaveUp`" wording without introducing a second, undocumented
   duration. The directory-watcher callback checks `Date.now() > fallbackArmedUntil` (with
   its own debug log) *before* the `hookConfirmed` check, matching the plan's snippet
   ordering — even a never-hook-confirmed scanner stops trusting the fallback once the
   window lapses.

### One deviation from the plan's literal snippets (noted per instructions)

The plan's proposed-fix snippet for item 3 declares `FALLBACK_ARMED_WINDOW_MS` as a bare
top-level `const` with no way to override it. Sub-task 5(c) requires a test for "the
fallback window's expiry is respected" without a real 30-second sleep. Added
`fallbackArmedWindowMs?: number` to `SessionScannerOptions` (mirroring the existing
`missingFileTimeoutMs`/`pollIntervalMs` test-override pattern already in this file),
defaulting to the constant. This is additive only — no behavior changes for any caller
that doesn't pass it.

## Tests (`packages/cli/src/claude/scanner.test.ts`)

- **(a)** New test: *"never adopts a sibling transcript file once hook-confirmed, even
  after its own tracked session was dropped"* — constructs with `sessionId: null`, calls
  `onNewSession("A")` once (the hook path), lets A's watcher give up
  (`missingFileTimeoutMs: 100`), then writes a sibling `B.jsonl` with real content. Asserts
  `seen` never contains B's entries and the "ignoring unrelated new transcript file (hook
  coverage active)" debug log fires with `newSessionId: "B"`.
- **(b)** Rewrote the pre-existing *"rotates to a new session automatically… (W3.8
  rotation fallback)"* test into the true no-hook-coverage case: it previously constructed
  with a non-null `sessionId` at construction, which under the new `hookConfirmed` seeding
  is itself now a hook-confirmed scanner and would (correctly) no longer rotate — so its old
  assertions were now testing the wrong thing. Rewritten to construct with `sessionId:
  null` and never call `onNewSession`, confirming the fallback still rotates onto a brand
  new file when there is genuinely no hook coverage at all.
- **(c)** New test: *"ignores a new transcript file once the fallback's armed window has
  expired, even with no hook coverage"* — constructs with a short
  `fallbackArmedWindowMs: 200`, lets it lapse, then writes a new file. Asserts it's never
  adopted and the "fallback window expired" debug log fires.
- Left the existing *"ignores non-.jsonl files…"* test untouched — its assertions are about
  the `.jsonl` filename filter, which runs before any of the new gating and is unaffected
  by it either way.
- Full existing suite (dead-session drop, revival-via-hook, pending-session bookkeeping,
  dedup/restart/flush/shutdown-tail behaviors) re-verified unchanged and still green — the
  hook-path revival test in particular continues to exercise `source: "hook"` (the default
  for the public `onNewSession` entry) reviving a dropped id, confirming that path wasn't
  narrowed by the `source` split.

All 15 tests in `scanner.test.ts` pass; full `falcon` package test suite (1449 tests) and
the whole-monorepo `pnpm build` / `pnpm typecheck` / `pnpm test` all pass. `pnpm lint`'s 98
pre-existing errors were confirmed (via `git stash`) to exist identically without this
change — unrelated formatting issues elsewhere on this branch, not introduced here; both
changed files pass `biome check` individually.

## Sub-task 6 ([human], skipped per instructions)

Repeating the real two-tmux-pane live repro and confirming via server-side decryption is a
manual/live verification step, explicitly out of scope for this automated unit.

## Residual risk (carried over from the plan, stated honestly)

For a genuinely hookless install where two truly concurrent, hookless sessions share the
same cwd, filesystem metadata alone still can't disambiguate which new file is "mine" — the
fix shrinks that window from "the whole session" to a bounded ~30s and eliminates the
overwhelmingly common case (hook coverage present, the default v2 architecture), but does
not claim to eliminate the theoretical no-hook race. A stronger fix (cross-referencing the
candidate file's first entry against the actual child process via the process-scanning
utilities `daemon/transcriptIndexer.ts` already uses) remains deferred, larger-scope work,
per the plan.

## Files changed

- `packages/cli/src/claude/scanner.ts`
- `packages/cli/src/claude/scanner.test.ts`
