# BF2.2 — web-polish-batch

Three small, disjoint-file web fixes batched into one inline pass (`docs/bug-fix-plan.md`
§3, §8, §13): the session-timeline message list didn't scroll, a subagent group's raw
internal `cuid2` leaked into visible chat text, and the Home sessions list flashed
"(untitled session)"/"(unnamed machine)" placeholder text on every load before
decryption finished.

## Sub-tasks

1. **Issue #3 — message list not scrollable**
   (`packages/web/src/components/timeline/SessionTimelineScreen.tsx`): the wrapper
   around `Timeline` (`<div className="min-h-0 flex-1 overflow-hidden">`) was a plain
   block box, so `Conversation`'s own `flex-1 min-h-0` Tailwind classes (which only take
   effect inside a flex container) never constrained its height — it grew to full
   transcript height and got silently clipped by the ancestor's `overflow-hidden`
   instead of scrolling. Changed the wrapper to
   `<div className="flex min-h-0 flex-1 flex-col overflow-hidden">`, matching every
   other flex-col wrapper already in this file. No automated test: jsdom doesn't
   compute real layout, so this class of bug (and its fix) is invisible to vitest —
   noted honestly per the plan rather than fabricating a layout assertion. Verified by
   reading the fix against the plan's root-cause analysis and confirming `pnpm build`/
   `next build` produce no errors; a real scroll-affordance check belongs in a
   Playwright/browser harness, which doesn't exist in this repo yet.

2. **Issue #8 — subagent raw id leaked into visible chat**
   (`SubagentGroup.tsx`, `RenderItemGroups.tsx`): `SubagentGroup`'s prop changed from
   `id: string` to `label: string`, rendering `{label}` instead of `Subagent {id}`.
   `RenderItemGroups`'s render loop now tracks a local `subagentOrdinal` counter,
   incrementing it per standalone `subagent-group` and passing
   `label={\`Subagent ${subagentOrdinal}\`}` — the internal `subagentId` cuid2 is no
   longer forwarded into visible text at all, only into the React `key` (which already
   embeds it via `group.id`).

3. **Issue #13 — sessions list flashes placeholder text on every load**
   (`types.ts`, `live-source.ts`, `session-card.tsx`, `machine-badge.tsx`):
   `SessionListSession.title` / `SessionListMachine.name` changed from `string` to
   `string | null`. `buildSnapshot` in `live-source.ts` now carries `titles.sessions.get(s.id) ?? null`
   / `titles.machines.get(m.id) ?? null` instead of defaulting through
   `?? UNTITLED_SESSION` / `?? UNNAMED_MACHINE` at read time — the map only ever
   acquires an entry once `decryptSessionTitle`/`decryptMachineName` has genuinely
   resolved (success or the honest placeholder fallback), so `null` now unambiguously
   means "haven't gotten to this row yet in the sequential decrypt queue."
   `SessionCard`'s `CardTitle` and `MachineBadge` both render the existing `Skeleton`
   component when the field is `null`, falling back to the literal placeholder text only
   once decryption has actually completed with nothing usable.

4. **Tests**:
   - `RenderItemGroups.test.ts` — new describe block rendering `RenderItemGroups` (via
     `renderToStaticMarkup`, this codebase's established pattern for `.test.ts` render
     assertions — see `skeleton.test.ts`/`session-card-actions.test.ts`) with two
     standalone subagent groups; asserts the output contains "Subagent 1"/"Subagent 2"
     and does **not** contain either group's raw `subagentId`.
   - `live-source.test.ts` — replaced the one existing test that asserted empty titles
     maps produced the placeholder strings (that was the exact bug) with a case
     asserting `null`, plus a new case asserting the placeholder strings still surface
     once the titles map has a real (post-decrypt) entry for them.
   - `session-card.test.ts` (new file) — `null` title renders a `Skeleton`
     (`data-slot="skeleton"` present, no "(untitled session)" text); a real string title
     renders as text with no `Skeleton` in the output. Wrapped in `QueryClientProvider`
     since `SessionCard` renders `SessionCardActions`, which calls
     `useArchiveSessionMutation`/`useDeleteSessionMutation` (needs a `QueryClient` in
     context even for an unopened dialog).

5. Combined: scoped tests green, `pnpm typecheck` green, commit.

## Drift from the plan / additional fixes required

The plan's snippets covered `RenderItemGroups.tsx`'s actual caller
(`RenderItemGroups`), but there is a second, unrelated dispatcher —
`packages/web/src/components/timeline/TimelineRow.tsx` — that also renders
`SubagentGroup` directly, one `RenderItem` at a time via a `switch (item.kind)` with an
`const exhaustive: never` compile-time guard. It isn't wired into any live render path
today (`Timeline.tsx` uses `RenderItemGroups`, not `TimelineRow`; grepped the whole
`src/` tree and the only reference to `TimelineRow` outside its own file is its own
test), but it still had to compile. Since it dispatches a single item with no sibling
context, there's no ordinal to compute there — fixed it with a generic
`label="Subagent"` fallback (no id, no fabricated number) rather than reintroducing the
leak or inventing a number that would always read "Subagent 1". Noted inline with a
comment explaining why this call site differs from `RenderItemGroups`'s.

Also needed: `@falcon/crypto` (subpath export `@falcon/crypto/web`, imported by
`live-source.ts`) had no build output in this freshly-provisioned worktree — `pnpm
install`'s postinstall only builds `@falcon/wire`. Ran
`pnpm --filter @falcon/wire --filter @falcon/crypto build` once before the test suite
would resolve; this is a worktree-provisioning step, not a code change.

`session-card.tsx`'s `<SessionCardActions title={session.title} />` call also needed a
fallback now that `title` can be `null` (`SessionCardActions`'s own `title: string` prop
feeds a delete-confirm dialog's copy, `Delete "{title}"?` — out of this batch's stated
scope, but required for `pnpm typecheck` to pass). Used `session.title ?? "this
session"` at the call site rather than widening `SessionCardActions`'s prop type or
threading a new `null` case through its dialog copy — minimal, and the archive/delete
actions are only reachable after a real card has rendered, by which point decryption has
very likely already resolved.

## Verification

- `pnpm --filter @falcon/web vitest run <the four test files above>` — all green
  (25 tests across the four files).
- `pnpm --filter @falcon/web test` (full web suite) — 90 files / 667 tests, all green.
- `pnpm build` — green, all 6 packages (including `@falcon/web`'s `next build`).
- `pnpm typecheck` — green, all packages (including `TimelineRow.tsx`'s `never` check
  and `session-card.tsx`'s `SessionCardActions` call).
- `pnpm test` (full monorepo) — green, all 11 package test tasks.
- `pnpm lint` (biome) — **not** clean, but confirmed via `git stash`/re-check that every
  violation biome reports in `RenderItemGroups.tsx`/`RenderItemGroups.test.ts` (the two
  files this batch touches that biome flags) is pre-existing formatting drift already
  present on `wf/BF2.2` before this session's edits — not introduced by this change. Ran
  `biome check` scoped to every file this batch created or touched and confirmed 9 of
  the 11 are fully clean; the remaining two's diagnostics are all on lines this batch
  never touched (verified by diffing biome's suggested reformat against `git diff`). The
  monorepo-wide `pnpm lint` run separately reports 96 pre-existing errors across
  `packages/cli`/`packages/wire` files this batch never opened.

## Files touched

- `packages/web/src/components/timeline/SessionTimelineScreen.tsx` — Issue #3 flex-col
  wrapper fix.
- `packages/web/src/components/timeline/SubagentGroup.tsx` — `id` → `label` prop.
- `packages/web/src/components/timeline/RenderItemGroups.tsx` — ordinal computation for
  standalone subagent groups.
- `packages/web/src/components/timeline/RenderItemGroups.test.ts` — new render-assertion
  describe block.
- `packages/web/src/components/timeline/TimelineRow.tsx` — generic `label="Subagent"`
  fallback for its own (currently unused) `SubagentGroup` call site (required for
  `pnpm typecheck`).
- `packages/web/src/features/session-list/types.ts` — `title`/`name` → `string | null`.
- `packages/web/src/features/session-list/live-source.ts` — `buildSnapshot` carries
  `null` instead of defaulting through the placeholder constants.
- `packages/web/src/features/session-list/live-source.test.ts` — updated/added
  `buildSnapshot` title/name cases.
- `packages/web/src/features/session-list/components/session-card.tsx` — `Skeleton`
  fallback for a `null` title; fallback string for `SessionCardActions`'s `title` prop.
- `packages/web/src/features/session-list/components/session-card.test.ts` — new file,
  `null`-vs-string title render assertions.
- `packages/web/src/features/session-list/components/machine-badge.tsx` — `Skeleton`
  fallback for a `null` machine name.

## Skipped

None — this unit has no `[human]`-marked sub-tasks.
