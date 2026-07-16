# P0-cross-cutting-mit-attribution-headers

Task: add MIT/Happy attribution headers to ported Happy-derived files that were
missing them, per plan.md's cross-cutting checklist item "MIT attribution
headers on every ported Happy file."

## What I found on this worktree's `main` base

The task brief listed 15 files as confirmed missing the header. Reading each
file directly (not through the `rtk` shell hook — see plan.md's own notes
about that hook fabricating `git`/`ls`/`grep` output) turned up a more nuanced
picture: **4 of the 15 already had a correct, sibling-format attribution
header** and were left untouched:

- `packages/cli/src/daemon/controlServer.ts` — already has "Ported verbatim
  from happy-cli/src/daemon/controlServer.ts (MIT) per plan.md §7.1"
- `packages/cli/src/daemon/types.ts` — already has "Adapted from
  happy-cli/src/daemon/types.ts (MIT)"
- `packages/cli/src/claude/fileWatcher.ts` — already has "Ported verbatim
  ... from happy-cli/src/modules/watcher/startFileWatcher.ts (MIT)"
- `packages/cli/src/claude/types.ts` — already has "Ported from
  happy-cli/src/claude/types.ts (MIT)"

I did not touch these four; re-adding a header would have been redundant.

## Files actually edited (comment-only, no logic changes)

**`packages/crypto/`** — `box.ts`, `box.web.ts`, `dek.ts`, `dek.web.ts` are
genuinely new code (plan.md §0.3 checklist tags them **(N)**, not (V)/(P)) —
Falcon-specific wrappers with no direct Happy source file. Rather than
fabricate a false "ported from Happy" claim for them, I added an honest note
that they are *not* themselves ports, crediting https://github.com/slopus/happy
(MIT) for the underlying primitives they call (`encryptWithDataKey`/
`decryptWithDataKey`/`libsodiumEncryptForPublicKey`/etc., which *are* ported —
see `encryption.ts`'s existing full MIT header) and pointing back to that file
for the actual license text.

`keys.ts` already had a solid attribution paragraph (adapted from Happy's
`happy-app/sources/encryption/deriveKey.ts`) but was missing the
`https://github.com/slopus/happy (MIT)` URL/license marker used by every other
sibling file — added it in place, no wording otherwise changed.

**`packages/cli/src/daemon/`** — `lock.ts`, `markers.ts`, `kill.ts`, `state.ts`
each already had some prose gesturing at Happy but none named the specific
source path + MIT license the way `controlServer.ts`/`types.ts` in the same
directory do. Brought all four up to that same bar:

- `lock.ts` — plan.md §7.4 explicitly names the ported function
  (`Happy's acquireDaemonLock`) and tags this bullet **(V)** (line 692) — cited
  `happy-cli/src/daemon` + the plan.md line.
- `markers.ts` — already named `daemon/doctor.ts`'s `findAllHappyProcesses`
  pattern; added the `https://github.com/slopus/happy (MIT)` marker.
- `kill.ts` — the SIGTERM→SIGKILL escalation policy itself is Falcon-specific
  (falcon-system-design.md §11, no Happy equivalent), so I attributed only the
  discovery primitive it composes (`processScan.ts`/`markers.ts`, themselves
  citing Happy's `doctor.ts`) and was explicit that the escalation logic is
  new — avoids overclaiming a "port" for code that isn't one.
- `state.ts` — plan.md §7.4/line 693 tags `daemon.state.json` **(P)**, citing
  Happy's `daemon/run.ts` state-publishing pattern generally (no single
  narrow source line, since Happy's version is folded into a bigger file) —
  attributed at that granularity.

**`packages/server/src/app/routes/`** — `auth.ts` already had a good
attribution paragraph, but it lived on the `buildAuthRoutes` function
docblock mid-file rather than a top-of-file header like every crypto/cli
sibling; added a short top-of-file header (source: `happy-server/.../
authRoutes.ts`, matching the Appendix table row at plan.md line 833: "port +
OAuth (D5)") and left the existing function-level explanation in place.
`oauth.ts` is genuinely new/delta code with no Happy equivalent
(plan.md's Appendix doesn't list it; its own docblock already said "not
present in Happy") — added a matching top-of-file header that credits the
reference repo while being explicit this route is *not* a port, consistent
with its sibling `auth.ts`.

## Assumptions / judgment calls

- Where plan.md's own checklist/Appendix tags a file **(N)** (new code) I did
  not claim it was "ported from Happy" — I attributed only the specific
  primitives/patterns that genuinely originate in Happy, and said plainly when
  a file (or part of one) is Falcon-original. Fabricating porting provenance
  for new code seemed worse than a technically-incomplete "attribution
  header" — the goal is accurate credit, not a checkbox.
- No exact line ranges are available for the daemon/kill/state files because
  there is no local copy of the `slopus/happy` source tree in this repo to
  cite line numbers from (only `plan.md`/`falcon-system-design.md`/
  `happy-research.md`'s prose descriptions) — cited file paths and, where
  named in plan.md, specific function names instead.
- Zero executable-logic changes: every edit is a doc-comment addition or
  extension to an existing doc-comment. No imports, exports, or runtime
  behavior touched.

## Verification

- `pnpm install` (fresh worktree, `node_modules` wasn't present)
- `pnpm build` — 5/5 packages, all green
- `pnpm typecheck` — 7/7 tasks, all green
- `pnpm test` — 9/9 tasks, 382 tests, all green (no test depends on comment
  content, so this simply confirms nothing else broke)
- `biome check .` (run directly with `NODE_OPTIONS=--max-old-space-size=4096`
  after the plain `pnpm lint` hit the environment's documented transient OOM
  even on retry) — exit code 0, 44 pre-existing warnings (`noExplicitAny`,
  `noNonNullAssertion` etc.), 0 errors, none introduced by this change.

## 2026-07-16 reconciliation (this session)

`git merge-base --is-ancestor P0-cross-cutting-mit-attribution-headers main`
confirmed the branch (tip `b67ad71`) was still not an ancestor of `main`,
which had advanced 50 commits since this branch's merge-base (`19776b4`) —
including real (non-comment) changes to `packages/cli/src/daemon/state.ts`
(an added `unlink` import/cleanup path) that plan.md's own Cycle 28 note
flagged as a possible overlap with concurrently-landing machine-ws-client
work.

Resolved by merging `main` into this worktree's branch in place
(`git merge main --no-edit`, merge commit `2ed4bfb`, parents `b67ad71` +
main's tip `3e59f6d`): the merge was fully automatic, no conflicts — the
`state.ts` overlap turned out to touch disjoint regions (main's new `unlink`
import vs. this branch's appended doc-comment paragraph) so git merged them
cleanly. Verified all 11 attributed files still carry their
`slopus/happy`/MIT marker post-merge.

Also flipped the plan.md §16 checkbox for "MIT attribution headers on every
ported Happy file" from `[ ]` to `[x]` and replaced the stale Cycle 28
"not credited" annotation with one describing this reconciliation.

Re-ran verification on the merged tree (`pnpm install` picked up new
dependencies main had added — `socket.io`, `socket.io-client`,
`@fastify/rate-limit`, `prom-client` — that weren't yet in this worktree's
`node_modules`):

- `pnpm build` — 5/5 packages green
- `pnpm typecheck` — 9/9 tasks green
- `pnpm test` — 9/9 tasks, 396 tests, all green

This commit is the reconciliation/merge step, done entirely inside the
worktree per this task's instructions (no push, no direct edit to the
primary `main` checkout). Fast-forwarding the shared `main` ref to this
result is a separate land step, expected to be trivial (fast-forward only,
since `main`'s tip is already one of this merge commit's two parents).
