# P3-web-codex-provider-picker

plan.md §16 "3.4 Codex adapter" — last unchecked bullet: `falcon codex`
command + provider pick in web spawn flow (beta banner).

## What was already done before this task

Checked the tree before writing anything: the CLI-side `falcon codex`
command was already landed (`P3-3.4-codex-adapter`, merge `e1e556b`), and —
contrary to that task's own "what was not built" note (which predates
`P3-3.1-web-new-session-flow` landing) — the web spawn flow already had:

- `NewSessionProvider = "claude-code" | "codex"` and `SpawnRequest.provider`
  in `packages/web/src/features/new-session/types.ts`.
- A `<select>` provider picker in `components/options-step.tsx`, with a
  plain `"Codex (beta)"` text option.
- `provider` threaded through `wizard-state.ts`'s `buildSpawnRequest` and
  `live-actions.ts`'s `machineRpcToActions().spawn()` all the way to the
  `spawn` machine RPC's `SpawnParamsSchema` (`packages/wire/src/rpc.ts`),
  which already accepts `z.enum(["claude-code", "codex"])`.

So the actual gap, matching this task's brief precisely, was narrower than
"no provider picker at all": the picker existed but Codex's beta status was
only a suffix inside a `<select>` option's text — not the "beta banner" the
design doc's resolution table (falcon-system-design.md §15, "Codex depth at
M3: beta banner") calls for, and nothing on the review step called it out
either.

## What this task added

- **`packages/web/src/features/new-session/provider-meta.ts`** (new): pure
  view-model module — `PROVIDER_META` (label + `beta` flag + `betaNote` per
  provider) and `PROVIDER_OPTIONS` (declaration-ordered pairs for rendering
  `<option>`s). Kept provider-independent so a third provider only needs a
  new map entry, not new UI branching.
- **`components/options-step.tsx`**: the provider `<select>` now renders
  from `PROVIDER_OPTIONS` instead of two hardcoded `<option>`s, and — when
  the selected provider is beta — renders an actual banner: a `Badge
  variant="warning"` reading "Beta" plus the explanatory note, in an amber
  bordered box (same visual language as the existing "directory doesn't
  exist yet" approval banner and `FileStatusBadge`/`MachineBadge` elsewhere
  in the app).
- **`new-session-screen.tsx`**: the review step's "Provider:" line now shows
  the human label plus the same `Badge variant="warning"` when the chosen
  provider is beta, so the beta status stays visible through to the final
  confirmation screen, not just the options step.
- **Tests**: new `__tests__/provider-meta.test.ts` (3 tests) covering the
  beta flags/notes and `PROVIDER_OPTIONS` ordering/identity; extended
  `__tests__/wizard-state.test.ts` with a test that `buildSpawnRequest`
  carries a non-default (`codex`) provider through untouched. This
  codebase's web tests are all pure-logic (`vitest`, `environment: "node"`,
  `include: ["src/**/*.test.ts"]` — no jsdom/testing-library, confirmed via
  `packages/web/vitest.config.ts` and the total absence of any
  `*.test.tsx`), so "component tests" here means testing the view-model/
  logic layer the components render from, matching every existing sibling
  file in `new-session/__tests__/`.

## What was not touched (already complete / out of scope)

- The `falcon codex` CLI command itself — already landed, out of this
  task's scope (`packages/web`-only per the brief).
- `SpawnParams`/wire schema, `live-actions.ts`, `wizard-state.ts`'s
  `buildSpawnRequest` — provider threading was already correct end-to-end;
  no changes needed beyond the new test.
- `mock-source.ts` — the mock actions already accept any `SpawnRequest`
  (including `provider: "codex"`) unmodified.

## Verification

- `pnpm build` (full monorepo via turbo) — 5/5 packages green.
- `pnpm --filter @falcon/web typecheck` — clean.
- `pnpm --filter @falcon/web test` — 43/43 files, 342/342 tests green
  (includes the 2 new/changed test files above).
- `./node_modules/.bin/biome check` on every file this task touched
  (`provider-meta.ts`, `options-step.tsx`, `new-session-screen.tsx`,
  `__tests__/provider-meta.test.ts`, `__tests__/wizard-state.test.ts`) —
  clean. A repo-wide `biome check packages/web/src/features/new-session`
  reports one pre-existing formatting finding in `directory-step.tsx`
  (confirmed via `git stash` that it fails identically without this task's
  changes) — untouched by this task.

## Assumptions

- "Beta banner" (design §15 resolution #3) is interpreted as a visible,
  dismissable-free inline notice component (badge + note), consistent with
  this codebase's existing amber-bordered-box convention for
  attention-worthy inline messages (the directory-creation approval prompt
  right below it in the same screen), rather than a page-level/toast
  banner — there's no separate site-wide banner system in this app to hook
  into, and a step-scoped notice keeps the warning next to the control that
  triggers it.
