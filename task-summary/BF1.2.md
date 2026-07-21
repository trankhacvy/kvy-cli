# BF1.2 — model-switch-render-fix

Bundle unit for bug-fix-plan.md Issue #4: a local Claude Code slash command
(e.g. `/model haiku`) was rendering as a raw chat bubble containing literal
`<command-name>`/`<local-command-stdout>` XML tags (and, when present, ANSI
escape codes), instead of a clean "Set model to Haiku 4.5..." service line.

No prior attempt existed in this worktree (`git log v2-pty-injection..HEAD`
was empty) — built from scratch per the plan.

## Changes

**`packages/cli/src/claude/modelChange.ts`**
- Exported `normalizeTranscriptText` (sub-task 1) so `envelopeMapper.ts` can
  reuse the exact ANSI-stripping/whitespace-collapsing cleaner instead of
  duplicating it.
- **Drift from the plan's snippet, adapted (sub-task 4):** the plan claimed
  `findClaudeModelChangeInEnvelopes`'s model-chip side channel would keep
  "working unchanged" once the chat-render fix routes `/model` output through
  a `service` envelope. That's not actually true against the real code: the
  function's guard was `envelope.ev.t !== "text"` — it only ever scanned
  `t: "text"` envelopes (reading `.md`), and would silently skip the new
  `t: "service"` envelope (which carries `.text`, a different field per
  `@falcon/wire`'s `SessionEventSchema`). Left as-is, the chat-bubble fix
  would have silently broken the model chip. Fixed by extending the scan to
  also check `t === "service"` envelopes (via their own `.text` field),
  keeping the pre-existing `t === "text"` branch intact for any assistant
  text that still contains a raw "Set model to X" string. Added tests for
  both branches plus a mixed-envelope-list precedence case.

**`packages/cli/src/claude/envelopeMapper.ts`**
- Added `LOCAL_COMMAND_STDOUT_PATTERN`/`LOCAL_COMMAND_INVOCATION_PATTERN`
  regexes and `extractLocalCommandStdout`/`isLocalCommandInvocation` helpers
  alongside `isCompactSummaryMessage` (sub-task 2), matching the plan's
  snippets essentially verbatim (only change: `match?.[1]?.trim() ?? null`
  instead of `match[1]!.trim()` to avoid a `noNonNullAssertion` lint warning
  the plan's literal snippet would have introduced — same behavior).
- In the `message.type === "user"` string-content branch, before the
  existing `isSidechainMessage` check (sub-task 3): a matched
  `local-command-stdout` becomes a quiet `agent`/`service` envelope with
  `normalizeTranscriptText`-cleaned text (no turn opened/closed, mirroring
  the compact-summary marker's precedent); a bare invocation record
  (`<command-name>` with no stdout yet) is dropped entirely.

**Tests**
- `packages/cli/src/claude/__fixtures__/model-change-session.jsonl` (new,
  sub-task 5): a two-line transcript reproducing a real `/model haiku`
  exchange — the invocation record
  (`<command-message>model</command-message><command-name>/model</command-name>`)
  and its `<local-command-stdout>Set model to Haiku 4.5 and saved as your
  default for new sessions.</local-command-stdout>` result — using the exact
  wrapper strings the plan's root-cause analysis quoted from the real
  source/transcript investigation (a live tmux capture wasn't available to
  this automated run; the strings are not guessed, they're the ones already
  verified in `docs/bug-fix-plan.md`'s Issue #4 root-cause section).
- `envelopeMapper.test.ts`: new golden-fixture test asserting
  `mapClaudeToEnvelopes` over that fixture produces exactly one `service`
  envelope with no XML tags/ANSI codes; plus two direct unit tests (a
  local-command-stdout result → clean service marker; a bare invocation →
  dropped, zero envelopes).
- `modelChange.test.ts`: extended with the same fixture strings — a
  `service`-envelope case for `findClaudeModelChangeInEnvelopes`, a
  mixed-envelope-list precedence case, and a direct test of the newly
  exported `normalizeTranscriptText`.

## Verification

- `pnpm build` — passes (includes `tsc --noEmit` per package).
- `pnpm typecheck` — passes.
- `pnpm --filter falcon test` / `pnpm test` — 132 files / 1456 tests pass.
- `pnpm lint` (root `biome check .`) still reports pre-existing repo-wide
  debt unrelated to this unit (96 errors / 132 warnings across the whole
  repo, e.g. `packages/cli/src/api/sessionMetadata.ts`,
  `e2e/src/fakeSessionProcess.ts`, `packages/cli/scripts/*` — none of it
  touched by this diff). Scoped to only the 4 files this unit changed:
  before hand-fixing, our new code/tests introduced 3 new format/lint
  errors and 2 new warnings on top of that baseline; all were fixed
  (`biome check --write` for formatting, manual optional-chaining rewrites
  for the two `noNonNullAssertion`/`useOptionalChain` warnings, and a
  manual rewrite of one test assertion whose regex had accidentally picked
  up a literal ESC control byte, which is what `noControlCharactersInRegex`
  was actually flagging). The one remaining error scoped to these 4 files
  (`modelChange.ts:3`, `noControlCharactersInRegex` on the pre-existing
  `ANSI_ESCAPE_SEQUENCE` regex) predates this change entirely (verified via
  `git show v2-pty-injection:.../modelChange.ts`) and is out of this unit's
  scope. Net effect: this unit introduces zero new lint errors or warnings
  anywhere in the repo.

## Skipped (as instructed)

- Sub-task 6 `[human]`: live `falcon claude` / `/model haiku` / web-timeline
  manual confirmation — excluded from the automated pipeline.
