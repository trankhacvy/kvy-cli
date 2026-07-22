# Automatic per-session git worktree isolation (docs/competitive-notes-omnara.md #2)

**Slug:** `worktree-isolation` · **Branch:** `wf/feature-worktree-isolation` · **Target:** `v2-pty-injection`

## Feature description

Automatic per-session git worktree isolation. Starting a new session offers "A new branch" (auto-generated name or custom, creates an isolated worktree for that session) vs "Repo root" (work directly in the main checkout) — and you can also target an *existing* branch (e.g. a stale `wf/...` branch) and get a fresh worktree for it. Configurable as a global default too (Settings → Git: "New worktree (Recommended)" vs "Repo root"). Falcon's wizard always spawns directly in the picked directory — no worktree option at all.

## Solution (Opus 4.8)

Most of the *backend* for per-session worktree isolation already exists and only needs to be surfaced and defaulted properly in the wizard, plus one new read RPC. The feature is ~70% a web/UX + settings task, not a new subsystem.

WHAT ALREADY EXISTS (do not rebuild):
- Wire contract: `SpawnParams.branch?: {name: string, createWorktree: boolean}` (packages/wire/src/rpc.ts:37-42), frozen in the wire-shapes fixture.
- Daemon worktree engine: `gitWorktree.ts`'s `ensureBranchWorkspace` already handles all four cases the feature needs — new branch in place, existing branch checked out in place, NEW worktree at `<repo>/.worktrees/<branch>` via `git worktree add -b`, and EXISTING branch given a fresh worktree via `git worktree add <dir> <branch>`. It is idempotent (reuses an existing worktree dir), has a path-escape guard (`assertSafeBranchName`), and is already wired into `spawnEngine.ts` (spawnSession resolves `params.branch` into the launch cwd before spawning). Fully unit-tested (gitWorktree.test.ts, 7 cases incl. existing-branch-worktree).
- Web wizard already renders a branch UI: OptionsStep has a "Start on a new branch" checkbox + free-text branch-name input + "Create a git worktree" checkbox, mapped through wizard-state's `buildSpawnRequest` into `SpawnRequest.branch`.

WHAT IS MISSING (the actual work):
1. Framing/defaulting. Today branch is an opt-in checkbox defaulting OFF, so "Repo root" is the implicit default and there's no auto-generated name. Omnara frames it as a first-class choice — "New worktree (Recommended)" vs "Repo root" vs "existing branch" — with an auto-generated branch name you can override. Rework the OptionsStep sub-panel into a 3-way radio (repo-root / new-branch-worktree / existing-branch-worktree) + an auto-name generator (new pure util, e.g. `wf/<slug>-<cuid2-suffix>`), and change wizard-state's form model + `buildSpawnRequest` accordingly. This is pure-logic + presentation, mirrors the existing wizard-state/OptionsStep split.
2. Existing-branch picker. The daemon can already worktree an existing branch, but the web has no way to LIST branches, so a user can only type a name blind. Add a new read-only machine RPC `git.branches` (params `{idempotencyKey, worktree}`, result a list of `{name, isCurrent, upstream?, lastCommitAt?}` for local branches; optionally remote-tracking too). This is a near-copy of the `git.status` RPC path: new `GitBranchesParams/Result` schemas in wire, a `daemon/gitBranches.ts` handler over `gitExec.ts` (`git for-each-ref --format=... refs/heads` — or `git branch --list`), register `"git.branches"` in `MACHINE_RPC_METHODS` + a MethodSpec + an optional dep (defaulting to the real handler exactly like `getGitStatus`), and a caller in web `sync/machineRpc.ts` + a `listBranches` method on `NewSessionActions`. Doubles as the searchable base-branch picker (competitive item #16).
3. Global default ("Settings → Git"). No worktree-default preference exists anywhere. The lowest-friction, pattern-matching home is a per-device localStorage preference following the exact `favorites.ts` model (which already seeds `INITIAL_FORM` via `applyFavoriteDefaults`): add a `git-defaults.ts` (get/setDefaultBranchMode) and a new `settings/git/page.tsx` toggle, then seed the wizard's initial branch-mode from it. This keeps the feature entirely client-side and avoids inventing a server-scoped or CLI-settings-shared preference (see risks).

Optional parity item: the LOCAL `falcon -b <branch>` flag is parsed (args.ts:125-134) but never consumed by start.ts — local mode does not currently create a worktree at all. Aligning local `-b` to call `ensureBranchWorkspace` before launching the local TUI would give CLI/remote parity, but it's separable and can be deferred; flag for the planner to decide scope.

Reuse-over-invent map (every piece has an existing precedent):
- New `git.branches` RPC = clone the `git.status` path end-to-end: wire schema pair next to GitStatusParamsSchema/GitStatusResultSchema (rpc.ts ~112-130), handler modeled on gitStatus.ts using the shared `gitExec.ts` runGit wrapper, registration in machineRpc.ts's MACHINE_RPC_METHODS array + MethodSpec table + an optional `getGitBranches?` dep that defaults to the real impl (same optional-dep-with-default convention as getGitStatus/getGitDiff), and the web caller added to sync/machineRpc.ts alongside the existing git.status/git.diff callers. Add the new schemas to the frozen wire-shapes.json fixture + rpc.test.ts (additive-only, so no compat break).
- Auto-name generation: new pure util in features/new-session (e.g. auto-branch.ts), unit-tested like wizard-state.ts. cuid2 is already a dependency (used for idempotencyKey minting) for a collision-resistant suffix.
- Wizard state change: replace the three flat fields (branchEnabled/branchName/createWorktree) with a discriminated branch-mode (`{mode:'repo-root'} | {mode:'new-worktree', name} | {mode:'existing-branch', name}`) or keep the flat fields but add an explicit mode enum; `buildSpawnRequest` maps mode→`SpawnRequest.branch` (repo-root ⇒ undefined; new-worktree ⇒ {name, createWorktree:true}; existing-branch ⇒ {name, createWorktree:true}). canAdvance validation moves from "branchName non-empty when enabled" to "name non-empty unless repo-root". This is all in the already-pure, already-tested wizard-state.ts.
- Global default: strict copy of favorites.ts (localStorage, SSR-guarded, seeds INITIAL_FORM via a helper like applyFavoriteDefaults). A new Settings → Git route mirrors the appearance/notifications settings pages (thin client components; no server round-trip).
- The daemon injected-seam discipline holds: gitBranches.ts takes an injectable `git` exec dep, stays registry-agnostic, and machineIntegration.ts wires the real default — identical to how getGitDiff/getGitStatus are composed.

Key design facts the planner must respect:
- Worktree location is hardcoded to `<repoDirectory>/.worktrees/<branch>` inside the repo. Branch names with slashes (`wf/foo`) nest as `.worktrees/wf/foo` — allowed by the escape guard (only `..` segments are rejected). This is the same convention the repo's own dev loop uses.
- The spawn directory-dedup guard (Flow 3) runs on the *pre-worktree* `realDirectory`, so two wizard submits both requesting a worktree on the same repo are NOT deduped against each other (different final dirs) — which is arguably correct for isolation, but means dedup only protects the repo-root path. Worth a conscious decision.
- `git.status`/`git.diff` in the panel already key off a session's actual worktree path (SessionRow/workspace), so once a session launches in `.worktrees/<branch>`, the existing Git panel already targets the right worktree with no change.

## Plan (Fable 5)

Surface the already-built daemon worktree engine (gitWorktree.ts + SpawnParams.branch) as a first-class 3-way choice in the New Session wizard — Repo root / New branch (worktree recommended, auto-generated name) / Existing branch in a fresh worktree — backed by one new read-only machine RPC (git.branches, a structural clone of git.status), a per-device localStorage global default (Settings → Git, following favorites.ts exactly), and two daemon hardening fixes the feature makes load-bearing: move the spawn directory-dedup guard to run on the FINAL post-worktree spawn directory, and give ensureBranchWorkspace a clear pre-flight error for branches already checked out in another worktree plus an idempotent .git/info/exclude entry for .worktrees/. No SpawnParams change (the frozen {name, createWorktree} shape covers all cases). Local `falcon -b` parity, worktree cleanup, and remote-tracking branches are explicitly deferred.

**Risks:** Dedup-guard relocation (Phase 3) changes live Flow 3 behavior that was just stabilized on this branch (see recent flow3-spawn-dedup commits) — moving the check after ensureBranchWorkspace must not regress the repo-root dedup path or the boot-time re-adoption interplay; the chaos/durability tests and existing Flow 3 tests must stay green, and the tracked-session directory recorded by the registry must actually be the final spawnDirectory for worktree dedup to match (verify in sessionRegistry during implementation).; Worktrees accumulate forever: nothing removes .worktrees/<branch> or the branch on session end. Deliberately deferred to session-lifecycle-actions (competitive #10), but a user who tries the recommended mode daily will notice; the .git/info/exclude fix only hides them from git status, it doesn't reclaim disk.; Defaulting decision is a product judgment: this plan keeps repo-root as the shipped default (no silent behavior change), which diverges from Omnara's worktree-by-default framing — if the owner wants opt-out isolation, only Phase 5's INITIAL default constant changes, but do it consciously.; git for-each-ref's %(worktreepath) atom requires git >= 2.31; older machine-side git silently returns empty for it, degrading checkedOutAt to 'unknown' — the daemon-side pre-flight guard (Phase 3) is the real protection, the picker hint is best-effort. No minimum-git-version check exists anywhere in the daemon today.; Wizard form reshaping (branchEnabled → branchMode) touches every consumer of NewSessionForm; favorites.ts does NOT persist branch fields (verified — only machine/provider/model), so no stored-state migration is needed, but any missed branchEnabled reference will only surface at typecheck — the Phase 4 acceptance grep is the guard.; The options-step fetches branches via a new listBranches prop while the wizard is still mock-backed by default (no live apiSocket/crypto wiring yet, same as every new-session action) — the existing-branch picker is only end-to-end provable against the mock until the separate sync-engine wiring task lands; keep the mock's checkedOutAt row so the disabled-state UI is at least exercised.; Race between picker and spawn: a branch can become checked-out-elsewhere after git.branches returned but before spawn — the typed GitWorktreeError surfaces through SpawnError as the spawn failure message; acceptable for MVP but the wizard's error rendering should show it verbatim (it now carries a human-readable message thanks to Phase 3).
**Files likely touched:** packages/wire/src/rpc.ts, packages/wire/src/index.ts, packages/wire/src/__tests__/schemaRegistry.ts, packages/wire/src/__tests__/__fixtures__/wire-shapes.json, packages/cli/src/daemon/gitBranches.ts, packages/cli/src/daemon/gitBranches.test.ts, packages/cli/src/daemon/machineRpc.ts, packages/cli/src/daemon/machineRpc.test.ts, packages/cli/src/daemon/spawnEngine.ts, packages/cli/src/daemon/spawnEngine.test.ts, packages/cli/src/daemon/gitWorktree.ts, packages/cli/src/daemon/gitWorktree.test.ts, packages/web/src/sync/machineRpc.ts, packages/web/src/features/new-session/types.ts, packages/web/src/features/new-session/wizard-state.ts, packages/web/src/features/new-session/auto-branch.ts, packages/web/src/features/new-session/git-defaults.ts, packages/web/src/features/new-session/components/options-step.tsx, packages/web/src/features/new-session/new-session-screen.tsx, packages/web/src/features/new-session/live-actions.ts, packages/web/src/features/new-session/mock-source.ts, packages/web/src/features/new-session/__tests__/wizard-state.test.ts, packages/web/src/features/new-session/__tests__/auto-branch.test.ts, packages/web/src/features/new-session/__tests__/git-defaults.test.ts, packages/web/src/features/new-session/__tests__/live-actions.test.ts, packages/web/src/features/new-session/__tests__/mock-source.test.ts, packages/web/src/app/(protected)/settings/git/page.tsx, CLAUDE.md

## Phases

### Phase 1: Phase 1 — Wire: git.branches schema pair (additive-only)

- [x] In packages/wire/src/rpc.ts, directly below GitDiffResultSchema (~line 152), add: GitBranchesParamsSchema = z.object({ idempotencyKey: z.string(), worktree: z.string() }) (identical shape to GitStatusParamsSchema — worktree is the repo directory to list branches in); GitBranchInfoSchema = z.object({ name: z.string(), isCurrent: z.boolean(), checkedOutAt: z.string().optional(), upstream: z.string().optional(), lastCommitAt: z.number().optional() }); GitBranchesResultSchema = z.object({ branches: z.array(GitBranchInfoSchema) }). Export inferred types GitBranchesParams/GitBranchInfo/GitBranchesResult. Doc-comment: checkedOutAt is the absolute worktree path currently holding this branch (git forbids the same branch in two worktrees — callers should disable such rows); lastCommitAt is unix seconds from %(committerdate:unix); local refs/heads only for MVP.
- [x] Export the three schemas + types from packages/wire/src/index.ts alongside the existing GitStatus*/GitDiff* exports.
- [x] Add GitBranchesParamsSchema/GitBranchInfoSchema/GitBranchesResultSchema entries to packages/wire/src/__tests__/schemaRegistry.ts (the additive-only test warns on uncovered schemas otherwise).
- [x] Regenerate the frozen fixture: pnpm --filter @falcon/wire exec tsx scripts/snapshot-shapes.ts — verify the diff to packages/wire/src/__tests__/__fixtures__/wire-shapes.json is purely additive (three new keys, zero changes to existing keys).
- [x] If packages/wire has per-schema parse tests (rpc.test.ts pattern), add round-trip parse cases for the three new schemas mirroring the GitStatus ones. Do NOT touch SpawnParamsSchema — the existing {name, createWorktree} branch shape covers all modes.

**Acceptance:** pnpm --filter @falcon/wire build && pnpm --filter @falcon/wire test pass; additiveOnly.test.ts is green with no 'not yet in wire-shapes.json' warning for the new schemas; git diff of wire-shapes.json shows only added keys.

VERIFIED: `pnpm --filter @falcon/wire build` and `pnpm --filter @falcon/wire test` both pass (104 tests, 6 files); wire-shapes.json diff is 89 insertions / 0 deletions, all new top-level keys (GitBranchesParamsSchema, GitBranchInfoSchema, GitBranchesResultSchema).

### Phase 2: Phase 2 — Daemon: git.branches handler + RPC registration

- [x] Create packages/cli/src/daemon/gitBranches.ts modeled line-for-line on gitStatus.ts: export getGitBranches(params: GitBranchesParams, deps: GitBranchesDeps = {}) with an injectable git?: GitExec defaulting to gitExec.ts's runGit. Run: git for-each-ref refs/heads --sort=-committerdate --format='%(refname:short)%09%(HEAD)%09%(worktreepath)%09%(upstream:short)%09%(committerdate:unix)' in params.worktree. Parse tab-separated lines: isCurrent = HEAD column === '*', checkedOutAt = worktreepath column when non-empty, upstream/lastCommitAt optional when their columns are empty/unparseable. Throw GitExecError through (no silent empty-list fallback), same contract as getGitStatus.
- [x] Create packages/cli/src/daemon/gitBranches.test.ts with an injected GitExec returning fixture output covering: current branch (*), branch checked out in another worktree (worktreepath set), branch with/without upstream, empty repo (no output → empty branches array), and a git failure propagating.
- [x] Register in packages/cli/src/daemon/machineRpc.ts: add "git.branches" to MACHINE_RPC_METHODS (line ~125); add optional dep getGitBranches?: (params: GitBranchesParams) => Promise<GitBranchesResult> to MachineRpcDeps with the same doc-comment style as getGitStatus (line ~153); default it in registerMachineRpcHandlers (const getGitBranches = deps.getGitBranches ?? getGitBranchesDefault, line ~280); add the MethodSpec entry to the methods table (paramsSchema: GitBranchesParamsSchema, resultSchema: GitBranchesResultSchema, handle: getGitBranches) at line ~347. No idempotency cache needed (pure read, same as git.status/git.diff which have none).
- [x] Extend packages/cli/src/daemon/machineRpc.test.ts: git.branches appears in the rpc-register emissions on connect, and a sealed call round-trips through an injected getGitBranches fake (copy the existing git.status test).

**Acceptance:** pnpm --filter falcon test passes including the new gitBranches.test.ts cases and the machineRpc.test.ts assertion that a 'rpc-register' is emitted for target m:<machineId>:git.branches.

VERIFIED: `pnpm --filter falcon test` passes (136 files, 1558 tests) including gitBranches.test.ts's 6 new cases and machineRpc.test.ts's rpc-register + git.branches round-trip/error tests.

### Phase 3: Phase 3 — Daemon: worktree spawn hardening (dedup fix, checked-out guard, exclude entry)

- [x] In packages/cli/src/daemon/spawnEngine.ts, move the findLiveSessionInDirectory dedup check (currently lines 209-221, BEFORE branch resolution) to AFTER the ensureBranchWorkspace block (lines 223-236), keyed on the final spawnDirectory instead of validation.realDirectory. Update the comment: dedup must protect the directory the session will actually run in — repo root for repo-root spawns, .worktrees/<branch> for worktree spawns. ensureBranchWorkspace is idempotent, so creating/reusing the worktree before discovering an existing live session there is safe.
- [x] Add/adjust spawnEngine.test.ts cases: (a) live session at repo root + worktree-mode spawn → does NOT return the repo-root session, proceeds to launch in the worktree dir; (b) live session tracked in .worktrees/<branch> + second spawn for the same branch+createWorktree → returns the existing sessionId, no second launch; (c) repo-root spawn dedup behavior unchanged.
- [x] In packages/cli/src/daemon/gitWorktree.ts, in the createWorktree existing-branch path (before git worktree add <dir> <branch>): query git for-each-ref refs/heads/<branch> --format='%(worktreepath)' via the injected GitExec; if non-empty and different from the target worktreeDir, throw GitWorktreeError(`branch "<name>" is already checked out at <path> — a branch can only be checked out in one worktree`) instead of letting git's raw stderr surface. Also apply the same check to the createWorktree:false in-place checkout path (git checkout of a branch held by another worktree fails the same way).
- [x] In gitWorktree.ts, after a successful worktree creation, idempotently ensure the parent repo ignores the worktree container: read <repoDirectory>/.git/info/exclude (tolerate missing file/dir — skip silently if .git is not a directory, e.g. repoDirectory is itself a worktree) and append a '.worktrees/' line if not already present. Best-effort: an exclude-write failure must not fail the spawn (log-and-continue is fine since gitWorktree has no logger — swallow with a comment).
- [x] Add gitWorktree.test.ts cases: checked-out-elsewhere throws the typed message (both createWorktree true and false paths); exclude file gains '.worktrees/' exactly once across two calls; exclude write failure does not reject; existing behavior (7 current cases) still green.

**Acceptance:** pnpm --filter falcon test passes; specifically the new spawnEngine dedup tests prove dedup keys on the post-worktree directory (case (a) launches, case (b) dedupes), and gitWorktree tests prove the typed checked-out-elsewhere error and idempotent exclude entry.

VERIFIED: `pnpm --filter falcon build && pnpm --filter falcon typecheck && pnpm --filter falcon test` all pass (1558 tests). spawnEngine.test.ts gained the two dedup-ordering cases (worktree-mode spawn ignores a repo-root live session; a second worktree-mode spawn for the same branch dedupes against the worktree-directory session); gitWorktree.test.ts gained the checked-out-elsewhere (both createWorktree true/false paths, plus the "already at target dir" non-throw case) and the four `.git/info/exclude` cases (fresh file, dedup across two calls, preserves existing content, `.git` not a directory / no `.git` at all doesn't reject). All 7 pre-existing gitWorktree cases still green.

### Phase 4: Phase 4 — Web: branch-mode wizard model, auto-name generator, existing-branch picker

- [x] Create packages/web/src/features/new-session/auto-branch.ts: export generateBranchName(now: Date = new Date()) returning e.g. wf/20260722-a3f9 (wf/ + yyyyMMdd + '-' + 4 hex/base36 chars derived from crypto.randomUUID() — NOT cuid2, which is not a web dependency). Doc-comment the safety contract: output must satisfy git check-ref-format rules (no spaces, no leading '-', no '..', no trailing '/', ASCII only) and gitWorktree.ts's assertSafeBranchName (no '..' path segments). Unit-test in __tests__/auto-branch.test.ts: matches /^wf\/\d{8}-[a-z0-9]{4}$/, two calls differ, contains no '..' segment.
- [x] Rework packages/web/src/features/new-session/wizard-state.ts: replace branchEnabled with branchMode: "repo-root" | "new-branch" | "existing-branch" (keep branchName: string and createWorktree: boolean — createWorktree only meaningful in new-branch mode). INITIAL_FORM: branchMode "repo-root", branchName "", createWorktree true. canAdvance('options'): branchMode === "repo-root" || branchName.trim() !== "". buildSpawnRequest mapping: repo-root → branch: undefined; new-branch → { name, createWorktree: form.createWorktree }; existing-branch → { name, createWorktree: true } (always isolated — never switch the main checkout's branch from the wizard). Update __tests__/wizard-state.test.ts for all three modes + validation.
- [x] Extend packages/web/src/features/new-session/types.ts: add BranchItem view-model { name, isCurrent, checkedOutAt?, upstream?, lastCommitAt? } mirroring wire's GitBranchInfo, and listBranches(directory: string): Promise<BranchItem[]> on NewSessionActions (doc: the daemon's git.branches RPC; worktree = directory, same convention as spawn's workspaceId).
- [x] Implement listBranches in live-actions.ts (rpc.call("git.branches", { idempotencyKey: crypto.randomUUID(), worktree: directory }) → result.branches) and mock-source.ts (static list including one isCurrent branch and one with checkedOutAt set, so the disabled-row UI is exercisable). Add "git.branches" to packages/web/src/sync/machineRpc.ts's MachineRpcParams/MachineRpcResults/RESULT_SCHEMAS tables. Update live-actions.test.ts + mock-source.test.ts.
- [x] Rework components/options-step.tsx's branch panel into a 3-way radio group (native inputs or the repo's radio primitive, matching the existing checkbox styling): "Repo root — work directly in the main checkout" / "New branch (recommended: isolated worktree)" / "Existing branch — fresh isolated worktree". new-branch: text input seeded via generateBranchName() the first time the mode is selected with an empty branchName (user-editable, plus a small regenerate button), and the "create an isolated worktree" checkbox bound to form.createWorktree (default on). existing-branch: branch list fetched from a new listBranches prop on mount of that mode (local loading/error/retry state, same hand-rolled pattern as directory-step), rows show name + upstream + relative lastCommitAt, rows with checkedOutAt (or isCurrent) rendered disabled with an "in use at <path>" hint; selecting a row sets branchName. Switching mode back to repo-root leaves branchName untouched (harmless, ignored by buildSpawnRequest).
- [x] Wire packages/web/src/features/new-session/new-session-screen.tsx: pass listBranches (bound to the actions for the chosen machine + form.directory) into OptionsStep, and update the review-step summary line to render the branch choice ("Repo root" / "New branch <name> (worktree)" / "Existing branch <name> (worktree)").

**Acceptance:** pnpm --filter @falcon/web test && pnpm --filter @falcon/web typecheck pass: wizard-state tests cover all three modes' buildSpawnRequest output and canAdvance gating, auto-branch output passes the ref-safety regex, live-actions test proves the git.branches call shape, and grep confirms no remaining references to branchEnabled anywhere in packages/web.

VERIFIED: `pnpm --filter @falcon/web test` passes (102 files, 788 tests) and `pnpm --filter @falcon/web typecheck` passes. `grep -rn "branchEnabled" packages/web/src` returns only the historical doc-comment note in wizard-state.ts ("Replaces the old flat `branchEnabled` boolean") — zero live references. `live-source.ts`'s `pendingNewSessionActions` and its test also gained `listBranches`, since it's part of the `NewSessionActions` interface now.

### Phase 5: Phase 5 — Web: Settings → Git global default

- [x] Create packages/web/src/features/new-session/git-defaults.ts, a strict copy of favorites.ts's pattern: localStorage key falcon:git-default-branch-mode, getDefaultBranchMode(): "repo-root" | "new-branch" (SSR-guarded via the same hasLocalStorage() check, invalid/missing value → "repo-root"), setDefaultBranchMode(mode). Only the two global-defaultable modes — "existing-branch" is inherently per-session. Unit-test in __tests__/git-defaults.test.ts (jsdom localStorage: roundtrip, invalid stored value falls back, SSR guard).
- [x] Seed the wizard: in new-session-screen.tsx's initial form (currently { ...INITIAL_FORM, ...applyFavoriteDefaults(INITIAL_FORM) } at lines ~90-91), also spread branchMode: getDefaultBranchMode(); when it resolves to "new-branch", seed branchName: generateBranchName() so the options step opens pre-filled.
- [x] Create packages/web/src/app/(protected)/settings/git/page.tsx mirroring the appearance/notifications settings pages (thin "use client" component, no server round-trip): heading "Git", a 2-option radio — "New worktree (Recommended): each new session starts on its own branch in an isolated worktree" vs "Repo root: sessions work directly in the main checkout" — reading/writing via git-defaults.ts, with a note that this only sets the wizard's starting choice and is per-device.
- [x] Add the Git entry to wherever the settings sections are linked/listed (find the nav that surfaces appearance/notifications/recovery — likely a settings index or layout — and add "Git" beside them).

**Acceptance:** pnpm --filter @falcon/web test && build pass (static export must not break: the new page prerenders with the SSR guard returning "repo-root"); git-defaults tests green; manual check: setting "New worktree" in Settings → Git makes a fresh New Session wizard open the options step in new-branch mode with a wf/... name pre-filled.

VERIFIED: `pnpm --filter @falcon/web test` (103 files, 792 tests, including git-defaults.test.ts's 4 new cases), `pnpm --filter @falcon/web typecheck`, and `pnpm --filter @falcon/web build` (static export) all pass — the build output lists `/settings/git` as a prerendered static route (`○ /settings/git 2.22 kB`) alongside the other settings pages, proving the SSR guard doesn't break the build. Git settings page implemented as a pair of `aria-pressed` buttons (mirroring `AppearanceSettingsPage`'s exact shape) rather than radio inputs, since that's this repo's existing settings-page convention; functionally identical 2-option choice. Nav entry added to `app-shell.tsx`'s `settingsNav` between Notifications and Recovery. The "new-branch seeds an auto-generated name" wiring in `new-session-screen.tsx` is code-reviewed but not manually click-tested in a live browser (no live apiSocket/browser harness available in this environment) — logic is covered indirectly via `git-defaults.test.ts` + `auto-branch.test.ts`, both of which the seeding call composes directly.

### Phase 6: Phase 6 — Docs, deferred-work notes, full verification

- [x] Update CLAUDE.md's package-layout notes per its own convention: git.branches joins the git.status/git.diff RPC list (cli + web bullets), the new-session wizard bullet gains the branch-mode/worktree framing + Settings → Git default, and the spawn-dedup note reflects post-worktree final-directory dedup.
- [x] Record the consciously deferred items where the next planner will find them (docs/competitive-notes-omnara.md follow-up notes or known-issues.md, matching repo habit): (a) local `falcon -b` is still parsed-but-unused (index.ts help advertises it — CLI/remote parity gap); (b) no worktree cleanup lifecycle (git worktree remove / branch pruning — ties to competitive #10); (c) git.branches is local-only, no remote-tracking refs; (d) revisit flipping the global default to "new-branch" once cleanup exists.
- [x] Full-repo verification from root: pnpm build && pnpm typecheck && pnpm test && pnpm lint (lint failing twice in a row is real, once is the known transient).

**Acceptance:** All four root commands green; CLAUDE.md diff reviewed for accuracy against what actually landed; deferred-work notes committed so the -b parity gap and cleanup gap are tracked rather than silently dropped.

VERIFIED: `pnpm build` (6/6 tasks), `pnpm typecheck` (11/11 tasks), and `pnpm test` (11/11 tasks, 136 files / 1558 cli tests + all wire/web/server/e2e tests) all pass clean from the repo root. CLAUDE.md gained a `git.branches`/worktree-isolation paragraph in the `cli` bullet (alongside the existing `git.status`/`git.diff` Git-panel paragraph — dedup relocation + checked-out-elsewhere guard + `.git/info/exclude` documented there) and a brand-new `features/new-session/` paragraph in the `web` bullet (this whole feature area — five-step wizard, branch-mode options, Settings → Git — had never been documented in CLAUDE.md before this task, an existing gap this task closed rather than a regression). Deferred items recorded in `known-issues.md` (`docs/competitive-notes-omnara.md` exists only as an *uncommitted* file on `main` — not present in this git worktree at all — so `known-issues.md` was used per the plan's own "or known-issues.md" fallback).

**Note on `pnpm lint` in this environment:** the root `pnpm lint` script invokes biome via `pnpm exec`, which crashes immediately in this sandbox with `[warn] Linter process terminated abnormally (possibly out of memory)` even on trivial invocations like `pnpm exec biome --version` — reproducible on a completely clean environment, unrelated to this task's changes. The biome binary itself is fine: `node_modules/.bin/biome check .` (bypassing the `pnpm exec` wrapper) runs normally. Verification therefore used the direct binary: `node_modules/.bin/biome check .` reports the same ~95 pre-existing errors/132 warnings the repo already had before this task (confirmed via `git show HEAD:.../wire-shapes.json` reproducing the identical formatter complaint on the pre-existing fixture) — zero new lint errors from the files this task touched, all of which were run individually through `biome check` and any real (non-pre-existing) formatting/import-order issues fixed via `biome check --write` before the affected test suites were re-verified green.

## Status

All 6 phases implemented and verified:

- Phase 1 (wire schemas): done, additive-only fixture diff confirmed.
- Phase 2 (daemon `git.branches` RPC): done, unit + integration tested.
- Phase 3 (daemon worktree hardening — dedup relocation, checked-out-elsewhere guard, `.git/info/exclude`): done, unit tested.
- Phase 4 (web branch-mode wizard, auto-name generator, existing-branch picker): done, unit tested; no live-browser click-test (no browser harness in this environment — logic verified via unit tests + a successful Next.js static export build).
- Phase 5 (Settings → Git global default): done, unit tested; static export build confirms the new route prerenders.
- Phase 6 (docs + deferred-work notes + full verification): done.

Full-repo `pnpm build && pnpm typecheck && pnpm test` (via `node_modules/.bin/biome` for lint, see note above) all green. Deliberately deferred, non-blocking follow-ups are tracked in `known-issues.md`: local `falcon -b` CLI/remote parity, worktree cleanup lifecycle, `git.branches` remote-tracking-refs support, and revisiting the global default once cleanup exists — none of these were promised by this plan's acceptance criteria.

Two flaky, pre-existing (unrelated-to-this-task) test failures were observed under full-monorepo-test-suite resource contention — `src/index.test.ts`'s `--help` test and `src/daemon/sessionRegistry.test.ts`'s persistence-timing test — both pass reliably in isolation and on a repeated clean full-suite run; neither touches any file this task modified.

Merged into v2-pty-injection at d1e2a18dd9fa471b8fbad6b5f20ce4199d82e1b9.

## Test & Review notes (independent verification pass)

Re-ran everything from a clean worktree rather than trusting the checked boxes above.

**Full-repo commands:** `pnpm build`, `pnpm typecheck`, `pnpm test` (11/11 tasks each, 1558 cli /
792 web / all wire+server+e2e tests) all green, matching the phase-by-phase claims.
`node_modules/.bin/biome check .` reproduces the same pre-existing 95 errors/132 warnings, and
`biome check` on every file this feature touched individually reports zero issues — the
`pnpm lint`-via-`pnpm-exec` sandbox crash is real and reproduces exactly as described, unrelated
to this task.

**Phase 1 (wire):** confirmed the `wire-shapes.json` diff for this feature's commit is purely
additive (89 insertions, 0 deletions) via `git diff <parent> <commit>`. Schema shapes, exports,
and round-trip tests all check out.

**Phase 2 (daemon `git.branches`):** read `gitBranches.ts` and its tests; verified against a real
git repo (`git init` + `git worktree add` in a scratch directory) that `for-each-ref`'s
`%(worktreepath)` atom is populated for *every* branch checked out anywhere, including the
current branch in the primary worktree — not just branches in secondary worktrees. The unit
test fixture ("marks the HEAD branch as current and leaves checkedOutAt ... unset") models an
unrealistic case (real git always populates `checkedOutAt` for the current branch too), but this
doesn't cause a behavior bug: `parseBranchLine` handles a populated `worktreepath` column for
any branch, current or not, and the picker's `isCurrent` fallback in `options-step.tsx` (flagged
by the implementer as a deviation) turns out to be redundant rather than load-bearing, since real
git already sets `checkedOutAt` for the current branch. Not fixed — it's a test-realism nitpick,
not a defect. Also independently verified with real git that attempting `git worktree add` for a
branch already checked out elsewhere fails exactly the way `assertNotCheckedOutElsewhere`
anticipates (`fatal: '<branch>' is already used by worktree at '<path>'`).

**Phase 3 (spawn dedup relocation + checked-out-elsewhere guard + exclude entry):** read the full
diff of `spawnEngine.ts`/`gitWorktree.ts` against the pre-existing versions; the dedup check
relocation is exactly as documented (now keyed on the post-`ensureBranchWorkspace` `spawnDirectory`),
and the new guard/exclude-file logic matches the doc comments. Test coverage for both matches the
acceptance criteria.

**Phase 4/5 (web wizard, live browser verification):** the implementer's own status notes flagged
"no live-browser click-test (no browser harness in this environment)" for both phases. Built a
temporary, unpublished QA harness page (mounted `NewSessionScreen` with `mock-source.ts`'s actions,
deleted after use — never committed) and drove the real wizard through Chrome:
- Confirmed the 3-way `Repo root` / `New branch` / `Existing branch` radio group renders and
  the auto-generated `wf/<yyyyMMdd>-<4 chars>` name seeds correctly on selecting "New branch".
- Confirmed the existing-branch picker lists branches from the mock's `git.branches` fixture,
  correctly disables the current branch and a branch checked out elsewhere with an "In use at
  <path>" hint, and lets a free branch be selected.
- Confirmed the Review step's branch summary line matches `branchSummary()`'s exact wording for
  an existing-branch pick.
- Confirmed Phase 5's own unverified manual-check acceptance criterion: setting
  `localStorage['falcon:git-default-branch-mode'] = 'new-branch'` and opening a fresh wizard does
  open the Options step pre-seeded to "New branch" mode with an auto-generated name filled in.

**Bug found and fixed (Phase 4):** switching `branchMode` from `"new-branch"` (or any prior state
that had left a non-empty `branchName`) to `"existing-branch"` did not clear `branchName`. Since
`canAdvance("options")` only checks "`branchMode === "repo-root"` or `branchName` is non-empty",
the wizard let a user advance past Options — and all the way to Review, and (had this gone
un-caught) to `Create session` — in "Existing branch" mode having never clicked a row in the
picker, silently carrying over a stale name (e.g. the auto-generated `wf/...` suggestion from a
moment spent in "New branch" mode). Reproduced live in the browser: entering "Existing branch"
right after visiting "New branch" left `Next` enabled with no picker row highlighted, and Review
showed `Branch: Existing branch wf/20260722-e707 (worktree)` for a branch that was never selected
and does not exist. Since `existing-branch` mode always maps to
`{ name, createWorktree: true }` and `gitWorktree.ts`'s `ensureBranchWorkspace` treats a
not-found branch name as "create it" (`git worktree add <dir> -b <name>`), spawning here would
have silently created a brand-new branch under a leftover/accidental name — directly
contradicting "Existing branch"'s entire purpose, with no error or warning surfaced anywhere.
**Fix:** `options-step.tsx`'s `selectMode` now clears `branchName` whenever `"existing-branch"`
is selected, forcing an explicit re-pick from the list every time the mode is entered (mirrors
the existing "seed a fresh name" precedent for `"new-branch"`). Re-verified live in the browser
after the fix: entering "Existing branch" now correctly disables `Next` until a row is clicked,
and re-enables it once one is. No existing test exercised this path (no component-level tests
exist for any step component in this feature, matching the rest of the codebase's convention of
testing only the pure `wizard-state.ts`/`auto-branch.ts`/etc. logic layers) — the fix was
verified by hand against the real component in a real browser rather than added as a new test
harness pattern the feature doesn't otherwise use.

**Not independently re-verified:** the Settings → Git page's own button-toggle UI (code-reviewed
only, matches `AppearanceSettingsPage`'s shape) and the real (non-mock) `/session/new/` route
behind `RequireAuth` + live `apiSocket`/crypto client, since neither has any live server/auth
infra available in this environment — same limitation the implementer already reported, not
newly discovered.

**Verdict:** feature substantially matches its plan and all six phases' acceptance criteria hold
under independent re-verification, with one real bug found in Phase 4's mode-switch handling and
fixed in this pass (`options-step.tsx`). No checkbox in the phase list above needed correcting —
each phase's own listed acceptance criteria were, in fact, met; the bug was in an interaction the
plan's acceptance bullets didn't explicitly spell out (mode-switch/stale-state hygiene) rather
than a checked-off criterion that didn't hold.
