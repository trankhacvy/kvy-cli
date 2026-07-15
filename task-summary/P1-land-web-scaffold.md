# P1-land-web-scaffold — Land the Next.js web app scaffold into main

**Section:** 1.6 Web app v1 (read-only), first bullet — `plan.md` §16.

## What was done

Merged the `P1-1.6-web-app-scaffold` branch (4 commits: feat + 2 fixes + a code-review
refactor) into `main` via a worktree at `.worktrees/P1-land-web-scaffold`, based off
current `main` (`2dcbde4`).

- `git merge --no-ff P1-1.6-web-app-scaffold` — the merge base (`2c520bb`) was already an
  ancestor of current `main` and nothing on `main` had touched the files the branch also
  touched (`CLAUDE.md`, `turbo.json`, `.gitignore`, `biome.json`, `pnpm-lock.yaml`), so the
  merge was clean with **no conflicts**.
- This lands `packages/web` (`@falcon/web`): Next.js App Router with static export
  (`output: "export"`), Tailwind v4 + shadcn/ui wired the v4 way (`@theme inline`,
  `components.json`), dark-default theme baked into `layout.tsx`, a ported shadcn `Button`
  primitive (+ tests), a placeholder landing route, a PWA manifest stub, a Vitest setup for
  the package, and monorepo wiring: `turbo.json` `@falcon/web#build`/`#test` task overrides,
  `.gitignore` (`.next/`, `out/`), and the root `CLAUDE.md` package-table update (moves
  `web` out of "planned").
- Checked off the "Next.js App Router scaffold, static export config, Tailwind + shadcn/ui
  init, dark default theme" bullet under `plan.md` §16 "1.6 Web app v1 (read-only)", and
  removed the stale cycle-9/cycle-10 "unmerged" tracking note on that section header now
  that the merge is done.

## Verification

- `pnpm install` — clean.
- `pnpm build` (root, Turborepo, first with warm cache then re-run with `--force` for a
  fully fresh build) — all 4 packages (`wire`, `crypto`, `server`, `web`) build green;
  Next.js compiles, prerenders `/` and `/_not-found` as static content, exports to
  `packages/web/out/`.
- `pnpm --filter @falcon/web typecheck` — clean (`tsc --noEmit`).
- `pnpm test` (root) — all 7 task nodes across `wire`/`crypto`/`server`/`web` pass: 65 +
  18 + 61 + 14 = 158 tests, 0 failures.

## Assumptions / notes

- No code changes were needed beyond the merge itself and the `plan.md` checklist update —
  the branch was already complete, reviewed, and verified per its own task-summary
  (`task-summary/P1-1.6-web-app-scaffold.md`, carried over by the merge).
- Did not touch any of the other 1.6 bullets (auth pages, crypto worker, `apiSocket`, sync
  engine, reducer port, session-list/timeline screens) — those remain `[ ]` and are
  separate, later tasks per the task description's explicit scope.
- Did not run `pnpm lint` (biome) — the source branch's own task-summary notes a
  pre-existing sandbox OOM on the full-repo biome scan unrelated to this change, and lint
  was not part of this task's stated verification bar (`pnpm build` +
  `pnpm --filter @falcon/web typecheck`).
