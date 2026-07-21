# BF1.3 — permission-mode-sync

Issue #5 (`docs/bug-fix-plan.md` §5): a local Shift+Tab permission-mode cycle in the
live TUI never reached the web mode chip — only a web-initiated "Approve & switch
mode" decision did. Fixed by adding a standalone `permission-mode` wire event and
threading it through the reducer and `deriveCurrentPermissionMode`.

## Prior attempt

`git log v2-pty-injection..HEAD --oneline` in the worktree showed no commits — this
unit had not been started (the `task-summary/` directory already contained finished
summaries for *other* landed units, e.g. `BF1.1.md`, but nothing for `BF1.3`). Built
from scratch per the plan.

## Sub-tasks

1. **Wire schema** (`packages/wire/src/session.ts`) — added
   `{ t: "permission-mode", mode: PermissionModeSchema, source: z.enum(["terminal", "client"]) }`
   as a new variant in `SessionEventSchema`'s discriminated union, alongside
   `mode-switch`. Additive only — no existing variant touched.

2. **`pretoolPermissionBridge.ts`'s `cachePermissionMode`** — now emits the new event
   via `this.deps.emitEnvelope` (already a required dep, already imported
   `createEnvelope`) whenever the observed mode is a genuine transition:

   ```ts
   if (this.lastPermissionMode !== null && mode !== this.lastPermissionMode) {
     this.deps.emitEnvelope(
       createEnvelope("agent", { t: "permission-mode", mode, source: "terminal" }),
     );
   }
   this.lastPermissionMode = mode;
   ```

   **Decision on the "first observed mode" question the plan explicitly left open:**
   does NOT emit on the very first observation (`lastPermissionMode` starting `null`).
   Rationale, documented inline on the method: the first hook call on any session
   reports whatever mode the TUI already happens to be in — that's an echo of
   already-current state, not a change, and would fire on literally the first
   `PreToolUse` of every session regardless of whether the user ever touched
   Shift+Tab. `deriveCurrentPermissionMode`'s `"default"` fallback already covers
   "no permission-mode event yet" correctly, so there's nothing to correct by
   announcing a baseline. Only genuine `A → B` transitions (`lastPermissionMode` was
   already set to something, and the new mode differs) emit.

3. **Reducer** — `PermissionModeItem` added to `packages/web/src/sync/reducer/types.ts`
   (`kind: "permission-mode"`, `mode: PermissionMode`, `source: "terminal" | "client"`)
   and added to the `RenderItem` union; `reduce.ts` gained the matching case
   mirroring `mode-switch`'s pass-through handling.

4. **`deriveCurrentPermissionMode`** (`session-state.ts`) — added
   `else if (item.kind === "permission-mode") { mode = item.mode; }` between the
   existing `mode-switch` and `perm-placeholder` branches. Both convergence paths
   (hook-observed `permission-mode` events AND web-initiated `perm-placeholder`/`tool`
   `mode` decisions) still coexist exactly as the plan requires — a web-initiated
   switch still reflects immediately, pending the hook echo that will later also land
   as a `permission-mode` item (redundant but harmless: both agree on the same mode).

5. **Tests**:
   - `pretoolPermissionBridge.test.ts` — new describe block
     "emits permission-mode on a genuine transition": first-observation-doesn't-emit,
     exactly-one-emit-on-real-transition (with the emitted envelope's shape asserted),
     no-re-emit-on-repeated-echo-of-the-same-mode, unrecognized-value emits nothing,
     and the same behavior verified through `handlePermissionRequest` (not just
     `handlePreToolUse`).
   - `session-state.test.ts` — a `permission-mode`/`source:"terminal"` item alone
     updates `deriveCurrentPermissionMode`, and a case asserting stream-order
     precedence when a `permission-mode` item is followed later by an unrelated
     `tool`-decision mode change.
   - Bonus (not explicitly required by the sub-task list, but cheap and mirrors
     `mode-switch`'s own precedent): extended `reduce.ts`'s existing
     "misc event pass-through" test to include a `permission-mode` envelope, and
     added a `reduce.test.ts` case for the new reducer branch.

6. `[human]` — skipped per instructions (live TUI Shift+Tab verification).

## Drift from the plan / additional fixes required

The plan's snippets were followed as-is (`session.ts`, `cachePermissionMode`,
`types.ts`, `reduce.ts`, `session-state.ts` all matched almost verbatim — no drift).
However, the plan didn't mention that `SessionEventSchema`'s discriminated union is
consumed by two **exhaustive** switches elsewhere in the codebase that a purely
additive wire change still breaks at compile time:

- `packages/cli/src/remote/messageBuffer.ts`'s `summarizeEnvelope` — a `switch (ev.t)`
  with no `default` case, relied on by TypeScript's control-flow analysis for the
  function's return type. Added a `case "permission-mode":` returning
  `{ content: \`🔀 Permission mode: ${ev.mode}\`, kind: "status" }`, matching
  `mode-switch`'s sibling case's status-line style. `pnpm build` failed with
  `TS2366: Function lacks ending return statement` here until this was added —
  confirmed via `git diff` that this file was untouched by any other in-flight
  change, so the break was caused by this unit's own wire addition.
- `packages/web/src/components/timeline/TimelineRow.tsx`'s `switch (item.kind)` has an
  explicit `const exhaustive: never = item;` compile-time guard in its `default`
  branch. Added a `case "permission-mode":` rendering a muted `ServiceLine` (
  `Permission mode: ${item.mode} (${item.source})`), matching `mode-switch`'s sibling
  case's presentation.
- `packages/web/src/components/timeline/transcript-view.ts`'s `isHiddenTimelineItem`
  (non-exhaustive, so this one wouldn't have failed the build, but was a real
  correctness gap): `permission-mode` items carry `role: "agent"` just like
  `mode-switch`, so leaving them out of the "hidden bookkeeping kinds" list would have
  let a `permission-mode` event get miscounted as a genuine agent reply by
  `hasVisibleAgentReplyAfterLatestUser` — incorrectly clearing the "Working…"
  indicator the moment a Shift+Tab happened mid-turn, independent of whether Claude
  actually replied. Added `item.kind === "permission-mode"` alongside `mode-switch` in
  the hidden-kinds list.

All three were found by actually running `pnpm build`/`pnpm typecheck` rather than
just reading the plan's snippets — the plan's proposed-fix code was correct as far as
it went but incomplete for a fully additive change in a codebase with several
exhaustive consumers of the wire union.

## Verification

- `pnpm build` — green (all 6 packages, including `@falcon/web`'s `next build` and
  `falcon`'s `tsc --noEmit && pkgroll`, which is what caught the `messageBuffer.ts`
  exhaustiveness gap above).
- `pnpm typecheck` — green (all packages, including `TimelineRow.tsx`'s `never` check).
- `pnpm test` — green for every package this unit touched
  (`packages/wire`, `packages/cli` scoped to `pretoolPermissionBridge.test.ts` and the
  full suite, `packages/web` scoped to `reduce.test.ts`/`session-state.test.ts` and the
  full suite): 657/657 web tests pass, 1456/1456 cli tests pass when run standalone.
  A full monorepo `pnpm test` run hit one **unrelated** flake —
  `falcon: src/index.test.ts > main() > prints help and exits 0 for --help` timed out
  at 5000ms under the resource contention of the full parallel turbo run; re-run
  standalone (`pnpm --filter falcon test`) it passed immediately. Confirmed via `git
  diff` that `src/index.test.ts` and everything it exercises are untouched by this
  unit.
- `pnpm lint` — could not be run to completion in this environment: `biome check .`
  (and even `npx biome --version` alone) fails immediately with
  `[warn] Linter process terminated abnormally (possibly out of memory)`, reproducing
  on every invocation including the script's own built-in retry. This is the
  pre-existing, extensively pre-documented environmental limitation called out in this
  repo's own `CLAUDE.md` and in essentially every prior unit's `task-summary/*.md` in
  this worktree (dozens of entries, e.g. `U1.6.md`, `U3.2.md`, `P4-4.3-blob-storage.md`)
  — not something introduced by this change. No formatting/lint issues are expected:
  all edits follow the exact style of the code immediately surrounding them (double
  quotes, existing import ordering, no new dependencies).

## Files touched

- `packages/wire/src/session.ts` — new `permission-mode` `SessionEventSchema` variant.
- `packages/cli/src/claude/pretoolPermissionBridge.ts` — `cachePermissionMode` now
  emits on genuine mode transitions.
- `packages/cli/src/claude/pretoolPermissionBridge.test.ts` — new emit-behavior tests.
- `packages/cli/src/remote/messageBuffer.ts` — `permission-mode` case for
  `summarizeEnvelope`'s exhaustive switch (required for `pnpm build` to pass).
- `packages/web/src/sync/reducer/types.ts` — new `PermissionModeItem` `RenderItem`.
- `packages/web/src/sync/reducer/reduce.ts` — new reducer case.
- `packages/web/src/sync/reducer/reduce.test.ts` — extended pass-through test.
- `packages/web/src/features/session-control/session-state.ts` —
  `deriveCurrentPermissionMode` new case.
- `packages/web/src/features/session-control/__tests__/session-state.test.ts` — new
  test cases.
- `packages/web/src/components/timeline/TimelineRow.tsx` — `permission-mode` render
  case (required for `pnpm typecheck` to pass, `never`-exhaustiveness guard).
- `packages/web/src/components/timeline/transcript-view.ts` — `permission-mode` added
  to the hidden/bookkeeping-kind list (correctness fix, not build-required).

## Skipped

- Sub-task 6, `[human]` live verification (Shift+Tab in the live TUI) — per
  instructions, not performed in this session.
