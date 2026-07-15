# P1-land-web-scaffold-onto-main — Land the P1-land-web-scaffold integration branch onto main

**Section:** 1.6 Web app v1 (read-only), first bullet — `plan.md` §16.

## What was done

Landed the `P1-land-web-scaffold` integration branch (which itself merges
`P1-1.6-web-app-scaffold`) into `main` via a worktree at
`.worktrees/P1-land-web-scaffold-onto-main`.

- **Fast-forward check first**: `P1-land-web-scaffold` was built on `main`'s tip as of
  `2dcbde4` (cycle 10). By the time this task ran, `main` had advanced 3+ chore cycles
  (`03c6537`, `bfb4792` had already landed pre-branch; then `b7a6f85` cycle 11, `cc17a14`
  cycle 12 landed after). **It was no longer fast-forwardable** — confirmed with
  `git merge-base main P1-land-web-scaffold` (`2c520bb`, several commits behind `main`'s
  tip). Diffing `main`'s advance (`2c520bb..cc17a14`) showed it only touched `plan.md` and
  `progress.md` (routine cycle-tracking notes), with zero overlap on the files this branch
  changes (`packages/web/**`, `turbo.json`, `CLAUDE.md`, `.gitignore`, `biome.json`,
  `pnpm-lock.yaml`).
- Created this worktree fresh off current `main` tip (`cc17a14`) and ran
  `git merge --no-ff P1-land-web-scaffold`. As expected, the only conflict was in
  `plan.md` — both sides had edited the same "1.6 Web app v1" section header (branch
  checked the box and dropped its stale "unmerged" tracking note; `main`'s later cycles
  had extended that same note and added an unrelated cycle-11 note to the neighboring
  "0.4 Server foundation" section). Resolved by keeping `main`'s newer prose framework and
  applying the branch's intent: checked off the bullet and replaced the stale
  cycle-9/10/12 "unmerged" note with a landed/verified note dated today. No other files
  conflicted — `packages/web/**`, `turbo.json`, `CLAUDE.md`, `.gitignore`, `biome.json`,
  `pnpm-lock.yaml`, and both carried-over task-summary docs merged cleanly.
- This lands `packages/web` (`@falcon/web`): Next.js App Router with static export
  (`output: "export"`), Tailwind v4 + shadcn/ui wired the v4 way (`@theme inline`,
  `components.json`), dark-default theme baked into `layout.tsx`, a ported shadcn `Button`
  primitive (+ tests), a placeholder landing route, a PWA manifest stub, a Vitest setup for
  the package, and monorepo wiring: `turbo.json` `@falcon/web#build`/`#test` task
  overrides, `.gitignore` (`.next/`, `out/`), and the root `CLAUDE.md` package-table
  update (moves `web` out of "planned").
- Checked off the "Next.js App Router scaffold, static export config, Tailwind + shadcn/ui
  init, dark default theme" bullet under `plan.md` §16 "1.6 Web app v1 (read-only)".

## Verification

- `pnpm install` — clean.
- `pnpm build --force` (root, Turborepo, forced fresh — no cache reuse) — all 4 packages
  (`wire`, `crypto`, `server`, `web`) build green; Next.js compiles, prerenders `/` and
  `/_not-found` as static content, exports to `packages/web/out/`.
- `pnpm --filter @falcon/web typecheck` — clean (`tsc --noEmit`).
- `pnpm test --force` (root) — all 7 task nodes across `wire`/`crypto`/`server`/`web`
  pass: 61 + 65 + 18 + 14 = 158 tests, 0 failures.

## Assumptions / notes

- No source code changes were needed beyond the merge and the `plan.md` conflict
  resolution — the branch's payload was already complete, reviewed, and verified per the
  carried-over task-summaries (`task-summary/P1-1.6-web-app-scaffold.md`,
  `task-summary/P1-land-web-scaffold.md`).
- Did not touch any of the other 1.6 bullets (auth pages, crypto worker, `apiSocket`, sync
  engine, reducer port, session-list/timeline screens) — those remain `[ ]` and are
  separate, later tasks per this task's explicit scope.
- Did not run `pnpm lint` (biome) as a landing gate — confirmed the `[warn] Linter process
  terminated abnormally (possibly out of memory)` failure is a pre-existing sandbox/host
  resource limitation reproducible on plain `main` before this merge, unrelated to this
  change, and not part of this task's stated verification bar (`pnpm build` +
  `pnpm --filter @falcon/web typecheck`).
- Removed the now-redundant worktrees `P1-1.6-web-app-scaffold` and `P1-land-web-scaffold`
  (and their branches) after landing, per the task description, since their content is now
  fully captured on `main`.
