# AH9 — remove-leaked-doc-strings

## What

`packages/web/src/app/(public)/password/page.tsx` had two `CardDescription`s rendering
internal planning-doc references verbatim to end users:

- `issue-4-plan.md §6.1/§6.4 PIN key custody.` (post-login "set up/unlock this device" card)
- `Email + password (issue-4-plan.md §5.2).` (sign-up/sign-in card)

Replaced with plain user-facing copy per the plan's proposed fix (item 9, folding in item
10's "this browser" framing for the first string):

```tsx
<CardDescription>Set up or unlock this browser's encrypted key material.</CardDescription>
...
<CardDescription>Email + password sign-in for local testing.</CardDescription>
```

## Why

`issue-4-plan.md §N.N` is an internal planning reference. Showing it in the UI is sloppy and
confusing to a real user — it's exactly the kind of leaked implementation detail item 9 in
`docs/auth-ux-hardening-plan.md` calls out.

## Assumptions

- Only the two `CardDescription` JSX strings were in scope, per item 9's proposed fix and its
  "What to verify" note that code *comments* referencing `issue-4-plan.md` are fine and
  expected to remain (they're developer-facing, not rendered) — item 9 only targets rendered
  JSX text. This matches sub-task 1's explicit "Replace both `CardDescription` strings" scope.
- No other file under `packages/web/src` renders `issue-4-plan.md`/`§` as JSX text (verified —
  see below); the only other hits are `//` or `/* */` comments in `page.tsx`, `signin/page.tsx`,
  `pair/page.tsx`, `DevicesSection.tsx`, `require-auth.tsx`, `pin-setup-form.tsx`,
  `pin-unlock-form.tsx`, `oauth-callback-page.tsx` — all left untouched, out of scope for this
  unit.
- This is a pure copy-only change (no logic, no props, no new strings elsewhere) — the
  CLAUDE.md live-verification carve-out for "pure copy/doc-only change" applies, but I still
  did a real render check (below) rather than relying on grep + unit tests alone.

## Verification

- `grep -rn "issue-4-plan" packages/web/src --include="*.tsx"` → 9 hits, all in `//` or `/**  */`
  comments (no JSX text). No `issue-4-plan.md` or `§` string remains in any rendered
  `CardDescription`/JSX in `/password/`.
- `git diff --stat` confirms exactly 1 file changed, 2 lines modified (the two
  `CardDescription`s) — nothing else touched.
- `pnpm build` — green (`@falcon/web` Next.js static export succeeds, `/password` route
  compiles and prerenders at 2.82 kB).
- `pnpm --filter @falcon/web test` — green, 153 test files / 1178 tests passed (no test
  asserts on this literal copy string, as expected for a pure-text change).
- `pnpm typecheck` — green (`tsc --noEmit` across all packages).

## Live verification (real)

Started `@falcon/web` dev server locally on port 3110 (`PORT=3110 pnpm --filter @falcon/web
dev`) and used the Chrome MCP tools to open `http://localhost:3110/password/` in a real tab and
read the rendered page text. Confirmed the sign-up card renders:

> "Email + password sign-in for local testing."

with no `issue-4-plan.md` or `§` text anywhere on the page. This is the unauthenticated
sign-up/sign-in view (default landing state of `/password/`), which is the string most
directly affected (the second `CardDescription`).

The other changed string (`Set up or unlock this browser's encrypted key material.`) sits on
the post-login "set up/unlock this device" card, which only renders after a real
password sign-in that resolves to `needs-unlock`/`needs-rotate` (i.e. requires the full
Postgres + `@falcon/server` + registered-account flow from CLAUDE.md's runbook). I did not spin
up Postgres/the server or drive a full sign-in for this unit, since the change is a pure
one-line copy swap with no conditional logic around it, identical in kind to the string I did
verify live, and `pnpm build`/`typecheck`/tests already prove it type-checks and compiles into
the page. I'm flagging this explicitly rather than claiming full end-to-end live verification:
**not independently live-verified: the post-login card's copy (verified by build/typecheck/grep
only, not by driving a real sign-in to that screen)**. If stricter proof is wanted, this would
need Postgres + server up and a real account taken through to `needs-unlock`/`needs-rotate`.

Dev server was stopped after the check (port 3110 freed, confirmed no listener remains).

## Files changed

- `packages/web/src/app/(public)/password/page.tsx`
