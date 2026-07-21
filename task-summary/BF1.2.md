# BF1.2 — model-switch-render-fix

Bundle unit for bug-fix-plan.md Issue #4: a local Claude Code slash command
(e.g. `/model haiku`) was rendering as a raw chat bubble containing literal
`<command-name>`/`<local-command-stdout>` XML tags (and, when present, ANSI
escape codes), instead of a clean "Set model to Haiku 4.5..." service line.

No prior attempt existed in this worktree (`git log v2-pty-injection..HEAD`
was empty) — built from scratch per the plan.

**Review pass (this session):** `git log v2-pty-injection..HEAD` showed two
existing commits (`feat: BF1.2 — model-switch-render-fix`, `test: BF1.2`).
Verified every sub-task 1-5 against the real code line-by-line (exports,
regex helpers, insertion point relative to `isSidechainMessage`, the
`findClaudeModelChangeInEnvelopes` `service`-branch extension, the fixture's
exact strings, and all test assertions) — everything matches the plan (with
the one intentional, already-documented drift below) and nothing was
missing or broken. The second commit only adds two extra regression tests
on top of the first (an ANSI-noise-outside-the-tags extraction case, and a
probe documenting that the local-command-stdout branch doesn't close an
already-open turn); no code changes beyond tests. No gaps found — nothing
to fill in.

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
- (second commit, additive) two more `envelopeMapper.test.ts` cases: ANSI
  noise surrounding (not inside) the `<local-command-stdout>` tags still
  extracts cleanly, and a probe documenting that the local-command-stdout
  branch intentionally does not close an already-open turn (asymmetric vs.
  ordinary user chat text, flagged as a documented behavior, not a bug to
  fix in this unit).

## Verification

- `pnpm build` — passes (includes `tsc --noEmit` per package).
- `pnpm typecheck` — passes.
- `pnpm --filter falcon test` / `pnpm test` — 132 files / 1458 tests pass
  (re-run this session; 2 more than the first commit's 1456 thanks to the
  second commit's two additional cases).
- `pnpm lint` (root `biome check .`): at commit time, scoped to only the 4
  files this unit changed, before hand-fixing our new code/tests introduced
  3 new format/lint errors and 2 new warnings on top of the repo's
  pre-existing debt; all were fixed (`biome check --write` for formatting,
  manual optional-chaining rewrites for two `noNonNullAssertion`/
  `useOptionalChain` warnings, and a manual rewrite of one test assertion
  whose regex had accidentally picked up a literal ESC control byte, which
  is what `noControlCharactersInRegex` was actually flagging). The one
  remaining error scoped to these 4 files (`modelChange.ts:3`,
  `noControlCharactersInRegex` on the pre-existing `ANSI_ESCAPE_SEQUENCE`
  regex) predates this change (verified via
  `git show v2-pty-injection:.../modelChange.ts`) and is out of scope.
  **Re-verification this session:** `pnpm lint` (and even a bare
  `npx biome check <single file>` / `npx biome --version`) failed with
  `[warn] Linter process terminated abnormally (possibly out of memory)`
  on every attempt, including after the documented one-shot retry — this
  machine had ~148MB of free physical memory at the time (`top`/`vm_stat`),
  i.e. real system-wide memory pressure from unrelated processes, not
  something scoping the lint invocation to fewer files could route around
  (even `--version` alone failed to spawn). This matches CLAUDE.md's
  documented transient-OOM caveat for this exact command. Deferred to a
  human re-run once memory pressure clears; not re-blocked on here since
  `git status` is clean (the code is byte-identical to what was already
  lint-verified clean at commit time) and `pnpm build`/`typecheck`/`test`
  all pass on the current tree.

## Skipped (as instructed)

- Sub-task 6 `[human]`: live `falcon claude` / `/model haiku` / web-timeline
  manual confirmation — excluded from the automated pipeline.
