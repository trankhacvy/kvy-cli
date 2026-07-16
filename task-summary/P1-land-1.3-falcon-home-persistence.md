# P1-land-1.3-falcon-home-persistence

Lands the `~/.falcon/` persistence layer (settings.json + access.key) onto `main`.

## What this task did

`main` had no `packages/cli/src/persistence.ts`. The complete, self-verified work
(including a code-review-fix commit) was sitting unmerged in worktree
`.worktrees/P1-1.3-falcon-home-persistence`, branch tip `77a2533`. That branch was
cut a long time ago and has drifted heavily from `main` (missing dozens of files
`main` has since gained across `daemon/`, `claude/`, `server/`, `web/`, etc.), so a
full branch merge would have deleted a large amount of unrelated work. Instead, this
task copied just the two new, disjoint files straight from the source branch tip into
a fresh worktree/branch cut from `main`'s current tip:

- `packages/cli/src/persistence.ts` (byte-identical to the source branch's tip —
  diffed to confirm)
- `packages/cli/src/persistence.test.ts` (byte-identical, 185 lines / 16 tests)

Both files only depend on `./home.js` (`resolveHomeDir`, already on `main`) and `zod`
(already a `packages/cli` dependency) — no other source changes were needed, and
nothing else on `main` references `persistence.ts` yet (grepped `index.ts` — no hits),
so there was zero merge conflict surface.

Also updated:
- `CLAUDE.md`'s `packages/cli` layout blurb — added a line describing
  `src/persistence.ts`'s settings/credentials storage.
- `plan.md` §16 "1.3 CLI skeleton + local mode" — flipped the `~/.falcon/` persistence
  bullet to `[x]` and appended a landing note.

## Implementation notes (ported code, for context)

Per Happy's `persistence.ts` (plan.md §2.1 pattern), adapted for Falcon's actual
settings shape (no `sandboxConfig`/`chromeMode` — Happy-specific, no Falcon
equivalent) and Falcon's single-`masterSecret` credential shape (vs. Happy's
legacy-vs-dataKey split):

- **`settings.json`**: schema-versioned (`SUPPORTED_SETTINGS_SCHEMA_VERSION`),
  field-by-field `normalizeSettings` extraction (unknown/missing fields silently
  fall back to defaults — never throws on a corrupt or future-schema file).
  `updateSettings(updater)` does an atomic read-modify-write: exclusive
  `O_CREAT|O_EXCL` lock file (100ms retry, 5s budget, stale-lock reclaim after 10s)
  guarding the critical section, tmp-file + `rename` (atomic on POSIX) for the
  actual write, lock file always cleaned up in a `finally`.
- **`access.key`**: zod-validated `{token, masterSecret}`, written 0600 via
  tmp-file + explicit `chmod` + `rename` (since `writeFile`'s `mode` option only
  applies on file *creation*, not overwrite, and `rename` preserves the source
  inode's mode). `readCredentials` returns `null` (never throws) on missing/corrupt/
  invalid-shape input. `clearCredentials` is a bare `unlink` with an ENOENT-only
  catch (no TOCTOU race between an existence check and the delete) — this was the
  code-review fix already baked into the source branch's tip commit.

## Assumptions

- Not wired into any call site (no `falcon auth login/logout/status`, no daemon
  settings reads) — that's explicitly out of scope per the task description, which
  frames this as unblocking the still-unmerged `P1-1.3-cli-auth-login` and the
  "Session bootstrap: mint DEK..." work, not performing them.
- Took the source branch's post-code-review-fix tip verbatim (`clearCredentials`'s
  bare-unlink/ENOENT-catch fix and the added concurrency test were already present
  at `77a2533`) rather than re-deriving anything.

## Verification

Run inside this worktree, from repo root:
- `pnpm install --frozen-lockfile` — clean.
- `pnpm build` — 5/5 tasks green (includes `falcon` cache-miss rebuild).
- `pnpm typecheck` — 7/7 tasks green.
- `pnpm --filter falcon test` — 17 files / 184 tests green, including the new
  `src/persistence.test.ts` (16 tests: defaults on missing/corrupt/array
  settings.json, known-field read-back + unknown-field stripping, updater
  create/persist-across-calls, no leftover `.lock`/`.tmp`, stale-lock reclaim,
  20-way concurrent-updater serialization with no lost increments, credentials
  null-on-missing/corrupt/invalid, round-trip, 0600 permission on write and
  re-lock-down over a pre-existing looser-permission file, clear + idempotent
  clear).

## Commit

Single commit on branch `P1-land-1.3-falcon-home-persistence` (cut from `main`
tip `acd4126`): adds the two source files, `task-summary/`, and the `CLAUDE.md`/
`plan.md` doc updates described above.

---

## Update 2026-07-16: reconciliation pass (this task)

`main` had moved 22 commits ahead (tip `237202d`) since this branch's base
(`acd4126`), while this branch itself had only picked up one extra commit
("fix: resolve test failures", tip `9bc3b6f`) — still genuinely unlanded.
Independently re-confirmed before touching anything:

- `git merge-base --is-ancestor P1-land-1.3-falcon-home-persistence main` →
  **not an ancestor**.
- `git cat-file -e main:packages/cli/src/persistence.ts` → **fails** (absent
  from main's tree).

### What was done

1. `git merge --no-ff main` into this worktree's branch. Exactly two
   conflicts surfaced, both non-code and as anticipated:
   - `CLAUDE.md` (`packages/cli` layout blurb) — merged both sides' prose
     (this branch's `persistence.ts` description + main's newer
     `ensureDaemonRunning()`/`falcon daemon` description).
   - `plan.md` §1.3 annotation block — took `main`'s side (its cycle-history
     prose was strictly newer, running through Cycle 42 and correctly
     recording this work as unlanded for 7+ consecutive cycles) and appended
     a fresh "Landed 2026-07-16 via `P1-land-1.3-falcon-home-persistence`
     (this task)" annotation on top, replacing the earlier branch's premature
     "Landed" claim that had never actually reached the shared ref.
   - `pnpm-lock.yaml` auto-merged with no manual resolution.
   - Zero conflicts touched `persistence.ts`/`persistence.test.ts` themselves.
   - Result: merge commit `7bdca3c` (parents `9bc3b6f`, `237202d`).
2. Flipped the `~/.falcon/` persistence bullet in `plan.md` §1.3 to `[x]`
   (it already carried a stray premature `[x]` from the branch's own commit;
   confirmed it now reflects an actually-reconciled, verified-green state).
3. Re-ran the full workspace suite post-merge:
   - `pnpm build` — 5/5 tasks green.
   - `pnpm exec turbo run typecheck --force` — 7/7 tasks green.
   - `pnpm exec turbo run test --force` — 9/9 tasks green, **519/519 tests**
     (crypto 65, wire 61, web 56, falcon 197 incl. `persistence.test.ts`'s
     16 tests, server 140). Higher than the "503 on main" baseline cited in
     the task because two other branches (`ensure-daemon-running`,
     `reducer-port`) landed on `main` during the same window; those tests
     are included and all passing.

### What was NOT done

Per this invocation's explicit operating constraint — *"Do NOT merge or
push — just commit in the worktree"* — the reconciliation merge above was
performed and committed **only inside this isolated worktree**
(`.worktrees/P1-land-1.3-falcon-home-persistence`). The shared `main` ref
itself was not touched: no checkout of `main`, no fast-forward/merge against
the primary repo, no push. The branch is now a clean, verified-green
merge commit (`7bdca3c`, second parent = main's current tip `237202d`) ready
for an actual land step by the orchestrator against the primary,
non-worktree `main` checkout.
