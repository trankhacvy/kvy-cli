# Auth UX Overhaul — Progress

Companion to `docs/auth-ux-overhaul-plan.md`, following the same convention as
`auth-ux-hardening-progress.md` / `bug-fix-progress.md`.

## Status: all 9 phases complete (5 gates + 97 tasks)

| Phase | Tasks | Outcome |
|---|---|---|
| G · decisions | 5 | Resolved to the plan's own recommended options; recorded in the plan. |
| 0 · shared copy | 4 | `cli/src/ui/messages.ts`, `web/src/lib/copy.ts` + two lint-style test suites. |
| 1 · CLI | 14 | Login gate moved to cover every provider; restartable `runPreflight`; daemon `/reload-auth`. |
| 2 · pairing gate order | 12 | Identity-first, approve card with machine/folder, success screen, `StartOverLink`. |
| 3 · onboarding | 5 | Zero-machine install guide that advances by itself. |
| 4a · session store split | 8 | Refresh token moved to its own store — "signed in, no keys" is now reachable. |
| 4 · key sharing | 22 | `key_requests` table + 4 routes, verification code, approve card, `falcon keys approve`. |
| 5 · PIN removal | 18 | PIN deleted end to end; PRF-or-device protection, one-time migration. |
| 6 · copy pass | 8 | Jargon sweep + principles added to `CLAUDE.md`. |
| 7 · later | 6 | Session quota, device labels, rate-limit keyer fix. |

## Verification

| Suite | Result |
|---|---|
| `pnpm typecheck` | 11/11 packages clean |
| `packages/cli` | 1970/1970 pass |
| `packages/web` | 1212/1212 pass |
| `packages/server` | 387 pass / 3 fail — all three pre-existing, see below |
| `biome check` (files touched by this work) | 0 errors, exit 0 |

**Pre-existing failures, not from this work:** `app/push/channels/{ntfy,telegram}.test.ts`
fail against the uncommitted edit to `app/push/channels/messageText.ts` that was already in
the working tree. Confirmed by stashing that file — both suites pass without it. Left alone
deliberately; it is in-progress work owned by someone else.

`db/seq.test.ts` talks to the real hosted Neon Postgres and carries a latency-sensitive
timing assertion, so it fails intermittently on network conditions
(`write CONNECT_TIMEOUT …neon.tech:5432`, and `expected 519 to be less than 350`). Nothing
to do with these changes.

**On `pnpm lint`:** that script never completes in this environment — it reports
`[warn] Linter process terminated abnormally (possibly out of memory)`, and so does
`biome --version`, so the wrapper is at fault rather than the code. Invoking
`./node_modules/.bin/biome check` directly works fine. The repo carries ~112 pre-existing
warnings across files untouched here; the files this work added or changed are at
**0 errors**.

**One regression caught late:** `config.test.ts` does a whole-object `toEqual` on the parsed
env, so adding `MAX_ACTIVE_SESSIONS_PER_ACCOUNT` broke it. It only surfaced once the suite
ran with reduced parallelism — earlier full runs were being killed before reaching it. Fixed,
plus a second test pinning the `0` default.

## Migrations added

- `0006_loose_adam_warlock.sql` — `pair_requests.label` / `.cwd`
- `0007_safe_glorian.sql` — `key_requests` table

## Not done, deliberately

- **No live end-to-end run.** Everything here is verified by typecheck + unit/integration
  suites. The tmux + Chrome-MCP runbook in `CLAUDE.md` (updated for the new flows) has not
  been executed against a running stack.
- **`falcon keys approve` is a command, not a prompt.** The daemon now *sees* key requests
  (`AX-4.17`) but deliberately never auto-approves. `AX-7.5` tracks turning that into an
  inline prompt inside a running session.
