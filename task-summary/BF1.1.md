# BF1.1 — core-loop-trivia

Two small, unrelated, disjoint-file fixes (docs/bug-fix-plan.md Phase 1), batched into
one inline unit per the bug-fix plan's grouping rationale.

## Issue #2 — stuck "Working…" status (verify only)

Already fixed in an earlier session (`packages/web/src/features/session-control/
session-state.ts`'s `deriveWorking`). Verified, did not re-implement:

- `session-state.test.ts`'s existing "never lets a stuck-true ephemeral override a turn
  that has already closed (the reported bug)" case (and the full 18-test suite) still
  passes unchanged.
- Added a guard-rail assertion to `SessionTimelineScreen.test.tsx` (a new `describe`
  block) confirming the component's source calls `deriveWorking(items,
  ephemeralWorking)` directly and never reintroduces the old
  `ephemeralWorking || isTurnOpen(items)` inline form.

**Assumption**: `SessionTimelineScreen` itself can't be rendered in this test file — it
pulls in the live sync engine, TanStack Query, and the session-scoped crypto worker via
hooks (`useLiveRenderItems`/`useSessionEphemerals`/etc.) that aren't wired up in this
project's `environment: "node"` vitest setup (no jsdom, no mocked sync stack — see the
existing test file's own header comment, which is why it only renders the hook-free
`isSessionControlDisabled`/`LifecycleBanner` exports via `renderToStaticMarkup`).
Rather than skip the requested assertion, the new test reads the component's own shipped
source text (`readFileSync`, same "exercise what's actually in the file" spirit as
`push/__tests__/sw.test.ts`'s VM-sandboxed `sw.js` test) and regex-asserts both that the
correct call is present and that the old buggy OR-form is absent. This is a deliberate,
narrower substitute for a full render assertion, chosen to match what the test harness
can actually exercise without inventing new mocking infrastructure the task didn't ask
for.

## Issue #11 — `falcon auth login` leaks abort listeners

`packages/cli/src/auth/pair.ts`'s `delay()` helper only removed its `abort` listener on
the timer-resolves path via the abort-callback itself firing (`{ once: true }` only
unregisters on an actual `abort` event). Since `pairDevice`'s poll loop reuses the same
long-lived `AbortSignal` every ~2s tick for up to the full 15-minute pairing timeout, a
never-aborted login left one dangling listener per tick, eventually tripping Node's
`MaxListenersExceededWarning`.

Fixed to match `scanner.ts`'s already-correct `wait()` pattern exactly: `onAbort` is
declared before `timer` so the timer's own callback can call
`signal?.removeEventListener("abort", onAbort)` on the normal (non-aborted) path too.
`delay` is now exported (previously module-private) solely so the new test can call it
directly.

**Test added** (`pair.test.ts`, new `describe("delay (Issue #11: ...)")`): creates a real
`AbortController`, spies on `addEventListener`/`removeEventListener`, calls `delay(0,
controller.signal)` in a loop 20 times without ever aborting, and asserts both spies were
called exactly 20 times each (no leaked listeners) and the signal never became aborted.

## Verification

- `pnpm --filter falcon exec vitest run src/auth/pair.test.ts` — 10/10 pass (9 existing +
  1 new).
- `pnpm --filter @falcon/web exec vitest run
  src/features/session-control/__tests__/session-state.test.ts
  src/components/timeline/SessionTimelineScreen.test.tsx` — 26/26 pass (18 + 8, incl. the
  2 new guard-rail assertions).
- `pnpm --filter falcon test` — 132 files / 1451 tests, all pass.
- `pnpm --filter @falcon/web test` — 88 files / 655 tests, all pass.
- `pnpm build` — all 6 packages build clean.
- `pnpm typecheck` — all packages typecheck clean.
- `biome check` on the 3 files this unit actually touched (`pair.ts`, `pair.test.ts`,
  `SessionTimelineScreen.test.tsx`) — clean. (`pnpm lint` at the repo root reports 98
  pre-existing errors in unrelated files from earlier, already-committed work — e.g.
  `modelChange.ts`/`sessionMetadata.ts` — not touched by this unit; confirmed via `git
  status` that this unit's only diffs are the 3 files above.)

## Files changed

- `packages/cli/src/auth/pair.ts` — `delay()` fix, now exported.
- `packages/cli/src/auth/pair.test.ts` — new leak-regression test.
- `packages/web/src/components/timeline/SessionTimelineScreen.test.tsx` — new
  `deriveWorking` wiring guard-rail tests.
