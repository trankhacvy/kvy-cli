# BF2.1 — plan-and-task-cards

Bundle covering docs/bug-fix-plan.md Issues #6 (`ExitPlanMode` raw-JSON
fallback) and #7 (`TaskCreate`/`TaskUpdate` raw-JSON fallback).

No prior commits existed on this branch (`git log v2-pty-injection..HEAD`
was empty) — this is a from-scratch implementation, not a gap-fill.

## Issue #6 — ExitPlanMode: done, in full

Implemented exactly per the plan's proposed-fix snippets; the code hadn't
drifted from what the plan described.

- `packages/web/src/lib/tool-args.ts`: added `ExitPlanModeArgs` +
  `parseExitPlanModeArgs(args)` — defensive `{ plan?: string }` reader,
  degrades to `undefined` on any shape mismatch (same pattern as every
  other parser in the file). Cross-checked the `{ plan: string }` shape
  against `features/session-control/__tests__/session-state.test.ts:38,58`,
  which already relies on it.
- `packages/web/src/components/timeline/tool-cards/ExitPlanModeToolCard.tsx`
  (new): renders the plan body via the existing `Markdown` component inside
  `ToolCardShell`, falling back to "No plan text recorded." when `plan` is
  missing/malformed. `ToolCardShell` already supplies the pending-decision
  Allow/Deny row generically (via `item.permission.decision === undefined`),
  so no special-casing was needed here, matching the plan's note.
- `packages/web/src/components/timeline/tool-cards/registry.tsx`: registered
  both `ExitPlanMode` and `exit_plan_mode` → `ExitPlanModeToolCard`,
  additive only (new import + two new map entries + one doc-comment line).

### Tests added

- `packages/web/src/lib/tool-args.test.ts`: `describe("parseExitPlanModeArgs")`
  — reads a plan string; degrades to `undefined` for missing/non-string
  `plan`; degrades to `undefined` for non-object/`undefined` args.
- `packages/web/src/components/timeline/tool-cards/ExitPlanModeToolCard.test.ts`
  (new): plan markdown renders via `Markdown`; missing/non-string
  plan/malformed args/`undefined` args all fall back to the "No plan text
  recorded." message rather than crashing. Uses the same
  call-the-function-directly-and-inspect-the-unrendered-element-tree
  technique as `BashCard.test.ts` — note `ExitPlanModeToolCard`'s returned
  element's `.props.children` *is* the body directly (a single JSX child,
  not wrapped further), unlike `ToolCardShell.test.ts`'s own helper which
  dives into `Tool`/`ToolContent` because it calls `ToolCardShell` itself
  as a plain function rather than through JSX.
- `packages/web/src/components/timeline/tool-cards/registry.test.ts`: new
  `describe("ToolCard registry — ExitPlanMode dispatch")` block asserting
  both `ExitPlanMode`/`exit_plan_mode` resolve to `ExitPlanModeToolCard` and
  not `McpGenericCard`.

All new/changed tests pass; full `pnpm test` (132 test files / 1467 tests
across the monorepo, including 90 web test files / 674 tests) is green.

### Sub-task 6 ([human], skipped per instructions)

Live manual repro (enter plan mode, trigger `ExitPlanMode`, confirm the web
timeline) was not performed — it's marked `[human]` and out of scope for
this automated pass.

## Issue #7 — TaskCreate/TaskUpdate: intentionally skipped (fixture precondition unmet)

Sub-task 4 (capturing a real `TaskCreate`/`TaskUpdate` transcript into
`packages/cli/src/claude/__fixtures__/task-create-update-session.jsonl`) is
explicitly marked `[human]` — it requires a live multi-step agentic Claude
Code session, which this automated unit cannot produce.

Re-verified the plan's own root-cause note before skipping:

```
grep -rn "TaskCreate\|TaskUpdate\|TaskView\|TaskList" packages/ \
  --include=*.ts --include=*.tsx --include=*.jsonl -l
# 0 matches
```

Still zero traces anywhere in the repo — no fixture, no prior parsing code,
no test data referencing these tool names. Per the task's explicit
instruction ("if the fixture isn't available yet, skip this sub-task rather
than shipping a guessed schema — the current raw-JSON fallback is honest
and strictly better than a wrong-but-confident card") and the bug-fix
plan's own §7 guidance ("do **not** ship a parser with guessed field
names"), sub-task 5 (`parseTaskEntryArgs`, `TaskEntryCard`, registry
entries for `TaskCreate`/`TaskUpdate`) was not implemented. `TaskCreate`/
`TaskUpdate` calls continue to render via the existing, honest
`McpGenericCard` raw-JSON fallback — unchanged, no regression.

Sub-task 6's `TaskCreate`/`TaskUpdate` half is likewise skipped (`[human]`,
and moot without the fixture).

**Follow-up needed**: a human session must capture a real
`TaskCreate`/`TaskUpdate` transcript (per docs/bug-fix-plan.md #7 step 1)
before Issue #7's card work can proceed.

## Verification

- `pnpm build` — green (all 6 packages, `@falcon/web`'s `next build` →
  static export included).
- `pnpm typecheck` — green.
- `pnpm test` — green, 132 test files / 1467 tests.
- `pnpm lint` (and its underlying `biome check .`) hits a pre-existing
  environment quirk in this worktree: invoking `biome` via `npx`/`pnpm
  exec`/the `lint` script's PATH resolution prints only `[warn] Linter
  process terminated abnormally (possibly out of memory)` and exits
  non-zero, even for `biome --version` — not specific to this change.
  Invoking the same binary directly
  (`./node_modules/.bin/biome check .`) works fine and is unaffected by
  this quirk. Scoped to just the files this unit touched
  (`tool-args.ts`/`.test.ts`, `registry.tsx`/`.test.ts`,
  `ExitPlanModeToolCard.tsx`/`.test.ts`), it reports exactly **one**
  pre-existing formatter diff in `tool-args.ts` (lines 12-14/206-208/
  300-320 — object-shorthand line-wrapping in code this unit did not
  touch, predating this change) and **zero** issues in any line this unit
  added. A repo-wide direct-binary run shows the same 96
  pre-existing errors / 132 warnings whether or not this unit's changes are
  present — no new lint errors introduced by this bundle.

## Files changed

- `packages/web/src/lib/tool-args.ts` (+`ExitPlanModeArgs`,
  `parseExitPlanModeArgs`)
- `packages/web/src/lib/tool-args.test.ts` (+`parseExitPlanModeArgs` tests)
- `packages/web/src/components/timeline/tool-cards/ExitPlanModeToolCard.tsx`
  (new)
- `packages/web/src/components/timeline/tool-cards/ExitPlanModeToolCard.test.ts`
  (new)
- `packages/web/src/components/timeline/tool-cards/registry.tsx`
  (+`ExitPlanMode`/`exit_plan_mode` registration)
- `packages/web/src/components/timeline/tool-cards/registry.test.ts`
  (+dispatch assertions)
