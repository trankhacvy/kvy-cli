# daemon-boot-codex-shim-recursion

## What

`codexProviderAdapter.ts`'s `detectCodex()` (via `defaultResolveVersion`) resolved the
`codex` CLI purely through the OS's normal PATH lookup — `execFileSync("codex", ["--version"], ...)`.
Once `falcon shim install` (FR-9.6) has put `~/.falcon/bin` at the front of `PATH`,
`~/.falcon/bin/codex` (`exec falcon codex "$@"`) wins that PATH race ahead of (or in place
of) any real Codex install. So any code path that calls `detectCodex()` — most notably
`falcon codex [args...]` (`commands/startCodex.ts`, including a daemon-spawned remote
session: `falcon codex --starting-mode remote --started-by daemon ...`) — ends up shelling
out to *itself*: `detectCodex()` → `execFileSync("codex", ["--version"])` → resolves through
the shim → `falcon codex --version` → a brand new `falcon codex` process → its own
`detectCodex()` call → the same shim again → ... an unbounded, synchronously-blocking chain
of `falcon codex --version` child processes (each parent waiting on its child via
`execFileSync`), matching the reported "runaway `codex --version` chain".

Fixed by giving Codex's adapter the same shim-skip guard `provider/claudeCliLocator.ts`'s
`findClaudeInPath` already has (added there for the identical historical Claude bug —
see its own regression test, "skips Falcon's own shim on PATH instead of resolving to it").
`codexProviderAdapter.ts` now has a `findCodexInPath(env)` helper: it resolves `codex` via
`which`/`where`, and if the resolved path's directory equals `shimBinDir(env)` it returns
`null` instead of that path. `defaultResolveVersion(env)` uses this resolved path — running
`execFileSync(<resolved absolute path>, ["--version"], ...)` (never the bare `"codex"`
command) — so there is no second PATH lookup left to re-resolve into the shim. If the only
`codex` on PATH is Falcon's own shim, `detectCodex()` now honestly reports "not installed"
(same as if there were no `codex` at all) instead of recursing.

## Why

Root-cause confirmed by reading `codexProviderAdapter.ts` next to its Claude sibling,
`provider/claudeCliLocator.ts` / `provider/claudeProviderAdapter.ts`: the Claude locator
already had this exact guard (`if (path.dirname(claudePath) === shimBinDir({ env })) return
null;`, with a comment explicitly describing the "loops or fails" self-recursion risk and a
regression test for it), but the Codex adapter — written later, and deliberately kept small
per its own file header ("detect() + startLocal(), not a full ProviderAdapter") — never
picked up the equivalent protection. `detectCodex()`'s `DetectCodexOptions.env` field was
even already declared for exactly this purpose but silently unused by
`defaultResolveVersion` (which took no arguments at all before this change).

## Assumptions / scope

- No `@falcon/wire` changes needed — this is a CLI-local process-detection bug.
- Codex has no multi-strategy locator like Claude's (npm/Homebrew/native-installer
  fallbacks) — by design (see file header: "Codex authenticates via its own `codex login`
  ... outside Falcon's control"). The fix mirrors only the shim-skip guard itself, not the
  rest of `claudeCliLocator.ts`'s machinery, since Codex's adapter was never meant to grow
  those extra install-method finders.
- `which`/`where` (via `execSync`, matching `claudeCliLocator.ts`'s own `findClaudeInPath`
  precedent exactly) always reads the real process `PATH`, not the `env` option — same
  documented caveat as the Claude locator; `env` is threaded through only to resolve
  `shimBinDir()`.

## Deviations from the design doc

The design doc handed to this task had only placeholder text ("probe"/"probe", files:
["a"]) — no real root-cause or fix plan was actually researched ahead of time. This pass
did that research itself (reading `codexProviderAdapter.ts`, `provider/claudeCliLocator.ts`,
`shim/paths.ts`, `shim/install.ts`, and `commands/startCodex.ts`/`args.ts` to trace the
actual recursive call path) rather than following any prior plan. No other deviation:
the fix directly reuses the existing, already-proven `claudeCliLocator.ts` pattern.

## Testing

- `packages/cli/src/codex/codexProviderAdapter.test.ts`: added a regression test
  ("skips Falcon's own codex PATH shim instead of recursing into it") that installs a fake
  `~/.falcon/bin/codex` shim script on `PATH` (mirroring `falcon shim install`'s exact
  layout) with no real `codex` install anywhere else on PATH, then calls `detectCodex()`
  with no `resolveVersion` override (so it exercises the real `findCodexInPath`/
  `execFileSync` path) and asserts an honest "not installed" result rather than a hang/
  recursion — mirrors `claudeCliLocator.test.ts`'s existing "skips Falcon's own shim on
  PATH" case.
- `pnpm --filter falcon build` (tsc --noEmit + pkgroll) passes.
- `pnpm --filter falcon test` (vitest run, full suite): 1512/1514 passing. The 2 failures
  (`src/claude/scanner.test.ts`, `src/daemon/transcriptIndexer.test.ts` — fs-watch/timing
  tests) are pre-existing and fail identically on unmodified HEAD (verified via
  `git stash`/re-run) — unrelated to this change.
- `pnpm typecheck` (turbo, all packages) passes.
- `biome check` on the touched files (`codexProviderAdapter.ts`,
  `codexProviderAdapter.test.ts`) is clean. (A full-repo `biome check .` surfaces ~96
  pre-existing errors/warnings across unrelated files — not touched by, or introduced by,
  this change.)
