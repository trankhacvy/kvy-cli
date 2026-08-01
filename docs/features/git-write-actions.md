# Real git write actions in the session sidebar (docs/competitive-notes-omnara.md #3)

**Slug:** `git-write-actions` · **Branch:** `wf/feature-git-write-actions` · **Target:** `v2-pty-injection`

## Feature description

Real git write actions in the session sidebar. [deep: git-write-actions] Kvy's git panel (kvy-prd.md FR-7.7) is explicitly read-only for the MVP. Omnara's sidebar has one-click Commit, Push, and Force Push, inline branch rename (click the branch name, it becomes an editable field), and a "Compare against" selector accepting any branch, tag, commit SHA, or HEAD (uncommitted) — not a fixed base ref.

## Solution (Opus 4.8)

## Feature #3 — Real git write actions in the session sidebar

The read-only git panel already exists end-to-end and establishes every pattern this feature needs. The work is: (a) add mutating git RPCs (`git.commit`, `git.push`, `git.renameBranch`, plus a compare-against ref source and optionally a base-ref-write RPC), (b) extend the web `GitDiffActions` seam and add a panel toolbar with inline branch rename + a "Compare against" selector, (c) handle the new hazards that mutating RPCs bring (idempotency, destructive-op confirmation, worktree-path authorization) that the read-only RPCs got to skip.

### What already exists (reuse, don't reinvent)
- **Daemon git handlers** (`packages/cli/src/daemon/`): `gitStatus.ts`, `gitDiff.ts`, `gitBranches.ts`, `gitWorktree.ts`, all built on the shared `gitExec.ts` `runGit(args, cwd)` execFile wrapper with `GitExecError`. Each has the same `deps.git?: GitExec` injectable-for-tests seam and "throw through, no silent fallback" contract. `gitWorktree.ts` already contains `assertSafeBranchName` (reuse verbatim for rename) and `assertNotCheckedOutElsewhere`.
- **Wire RPCs** (`packages/wire/src/rpc.ts`): `git.status`/`git.diff`/`git.branches` params+result schemas. `GitDiffParams.baseRef` ALREADY exists — the "Compare against any ref" backend is mostly built; `gitDiff.ts`'s `isSafeRevision` guards a `-`-prefixed ref, and `git diff <ref>` is two-dot so it includes uncommitted work. `git.branches` already lists local `refs/heads` with `isCurrent`/`upstream`/`checkedOutAt`.
- **RPC dispatch** (`packages/cli/src/daemon/machineRpc.ts`): `MACHINE_RPC_METHODS` table + per-method decrypt/validate/run/seal pipeline, and two reuse-ready idempotency helpers — `withIdempotencyCache` (caches settled promises, never caches a rejection, keyed on `idempotencyKey`+params JSON) which is exactly what commit/push need.
- **Web seam** (`packages/web/src/features/git-diff/`): `GitDiffActions` interface + `machineRpcToGitDiffActions` adapter + `useGitPanel` (TanStack `useQuery`) + `GitDiffPanel`/`SessionGitScreen`. `sync/machineRpc.ts` is the typed caller table. `features/session-control/`'s `Composer` shows the exact `useMutation` → optimistic → invalidate pattern to copy for write buttons.
- **Base-ref persistence** (`packages/cli/src/workspaceConfig.ts`): `settings.json` `workspaces` map, atomic lock-guarded, keyed by symlink-resolved path — already read by `git.diff`'s `resolveConfiguredBaseRef`. Writing it from web is the only missing half (today only the CLI `kvy workspace config` writes it).

### Proposed new RPCs (all purely additive to the wire — safe under the additive-only policy)
1. `git.commit` `({idempotencyKey, worktree, message, stageAll?, amend?})` → `{committed: boolean, commitSha?: string, nothingToCommit?: boolean}`. MUST go through `withIdempotencyCache` — a retried commit after a lost ack must replay the prior commit's SHA, never create a second commit.
2. `git.push` `({idempotencyKey, worktree, remote?, branch?, force?, setUpstream?})` → `{ok, remote, branch, forced}`. Also idempotency-cached. `force` drives `--force-with-lease` (safer than raw `--force`; decide below).
3. `git.renameBranch` `({idempotencyKey, worktree, to, from?})` → `{ok, branch}` via `git branch -m`. Reuse `assertSafeBranchName`; pre-flight `assertNotCheckedOutElsewhere`-style guard.
4. Compare-against ref source: either extend `git.branches` result (additive) to also include tags/remote-tracking refs, OR add a small `git.refs` RPC — free-text entry covers arbitrary SHAs regardless.
5. (Optional) `workspace.setGitConfig` `({idempotencyKey, directory, baseRef?, remote?})` → the config — a thin RPC around `workspaceConfig.ts`'s `setWorkspaceGitConfig`, modeled on the existing `workspace.register` RPC (`workspaceRegisterRpc.ts`), so the web selector can "save as default". Only needed if the compare-against choice should persist rather than stay session-local UI state.

### Web changes
- Extend `GitDiffActions` (`types.ts`) with `commit/push/forcePush/renameBranch/listRefs` (+ optional `setBaseRef`); add each to `machineRpcToGitDiffActions` (`live-actions.ts`) and `mock-source.ts`.
- Add methods to `sync/machineRpc.ts`'s `MachineRpcParams`/`MachineRpcResults`/`RESULT_SCHEMAS`.
- `useGitPanel`: add TanStack `useMutation`s that invalidate `["git-status", worktree]`/`["git-diff", ...]` on success (copy `Composer`'s pattern); hold the compare-against ref in `useState` (default = configured baseRef → HEAD), feed it into the existing `fetchDiff` `baseRef` arg.
- New UI in `GitDiffPanel`: a toolbar with the branch name (click-to-edit inline rename field), a commit message box + Commit button, Push, Force Push (destructive — confirm dialog), and a "Compare against" dropdown built over `git.branches`/refs + a free-text input.

Where write actions run: git.status/diff/branches today run `git` in whatever `worktree` the caller sends with NO validation against the workspace registry. For read-only ops that's a bounded info-leak; for commit/push/force-push it's a genuine "execute in arbitrary directory" concern that design §12 ("no arbitrary-directory execution from remote") speaks directly to. `packages/cli/src/workspace/registry.ts` already exports `isWithinRegisteredWorkspace` — the mutating handlers (and arguably the read ones too) should gate on it in `machineIntegration.ts`. This is the single most important architectural decision here.

Idempotency asymmetry: the existing git RPCs are documented as needing NO idempotency cache because they only read. Commit is the opposite — non-idempotent by nature. The `withIdempotencyCache` helper already in machineRpc.ts is the right tool; commit/push must be wrapped, unlike their read-only siblings. Push is close to naturally idempotent (re-pushing the same commits is a no-op) but force-push-with-lease can fail differently on replay, so cache it too.

Compare-against is mostly done on the backend: `GitDiffParams.baseRef` + `isSafeRevision` + two-dot `git diff` already give "compare working tree against any ref including HEAD-uncommitted." The feature gap is almost entirely UI (a picker) plus deciding whether the choice persists (reuse `workspaceConfig.ts`) or stays ephemeral panel state. `HEAD (uncommitted)` is literally the current no-baseRef default.

Credential/remote model for push: the daemon shells out to the user's own `git`, so push auth is the machine's existing git credential helper / SSH agent — Kvy manages none of it. A machine with no configured credentials just gets git's own error surfaced through `GitExecError`. Worth stating explicitly rather than building any credential UI.

Staging strategy for one-click commit is undecided and load-bearing: Omnara's "Commit" is one click with no staging UI, implying either `git commit -a` (tracked only, misses new files) or `git add -A && git commit` (everything). The `stageAll?` param lets the UI choose; pick a default.

Everything in web `features/git-diff/` is still on the injectable mock seam and not yet wired to a live `apiSocket` + per-machine crypto client (a general, pre-existing gap noted in CLAUDE.md for all web features, not specific to this work). The write actions inherit that state — they'll light up when the shared live-wiring lands, same as status/diff.

Wire mechanics: new schemas must be added to `packages/wire/src/__tests__/schemaRegistry.ts` and the `wire-shapes.json` fixture regenerated (never hand-edited) or `additiveOnly.test.ts` fails on "not yet in fixture." Adding brand-new methods/schemas is fully additive and safe; the only thing that would break compat is retyping an existing field.

## Plan (Fable 5)

Add mutating git machine RPCs (git.commit, git.push, git.renameBranch) to the daemon, gated on the registered-workspace registry (design §12) and wrapped in the existing withIdempotencyCache, then extend the web git panel's GitDiffActions seam with those writes plus a "Compare against any ref" selector built on the already-existing GitDiffParams.baseRef + git.branches. Five phases: (1) additive wire schemas + fixture regeneration, (2) daemon handler modules with worktree authorization and unit tests, (3) machineRpc registration + idempotency replay tests, (4) web RPC plumbing through sync/machineRpc.ts and the GitDiffActions seam with TanStack mutations, (5) toolbar UI (inline branch rename, commit box, Push, Force Push behind a confirm dialog, compare-against selector) + docs updates. Force push is --force-with-lease only; one-click commit defaults to git add -A (commit what the panel displays, including untracked); compare-against choice is ephemeral panel state (workspace.setGitConfig RPC deferred); no new git.refs RPC (local-branch dropdown + free-text ref input).

**Risks:** Security escalation is live immediately: unlike the proposal assumed, GitDiffPanel already defaults to the live DEK-gated RPC client (use-live-git-diff-actions.ts), so a missing worktree-authorization check would let any authenticated device run git writes in arbitrary machine paths the moment Phase 3 lands — the Phase 2 authorizer must land before or with Phase 3, never after.; Idempotency-cache lifetime is in-memory per daemon process: a daemon restart between a commit and its lost-ack retry re-runs the commit (double commit). Accepted for MVP (same exposure as adopt.take), but worth a header-comment acknowledgment; do not silently claim full exactly-once.; Argument-injection via wire strings: commit message is safe as its own argv element, but branch/remote/from/to/baseRef all reach git argv — every one must go through the leading-'-' / '..'-segment guard; a missed one turns a wire string into a git option (the exact --output= exfiltration gitDiff.ts documents).; Force-push-with-lease can still discard a collaborator's work when the local remote-tracking ref is stale-but-matching; the confirm dialog plus lease is mitigation, not elimination — copy in the dialog must not overpromise safety.; 'nothing to commit' detection is stderr-string matching against git's localized/version-varying output; a mismatch degrades to a thrown GitExecError shown to the user (annoying, not dangerous) — keep the regex loose and the failure mode throw-through, never a fabricated success.; Push depends on the machine's ambient git credentials/SSH agent; on a headless daemon a credential-helper prompt could hang the RPC rather than fail — consider GIT_TERMINAL_PROMPT=0 in gitPush's env if hangs are observed during verification.; wire-shapes.json regeneration is only a console WARNING in additiveOnly.test.ts, so forgetting it ships silently; the plan makes it an explicit Phase 1 task and acceptance check.; Two devices mutating the same worktree concurrently rely on git's own index/ref locking (documented decision, no resource-keyed guard) — acceptable, but error UX must surface the loser's GitExecError clearly.
**Files likely touched:** packages/wire/src/rpc.ts, packages/wire/src/rpc.test.ts, packages/wire/src/__tests__/schemaRegistry.ts, packages/wire/src/__tests__/__fixtures__/wire-shapes.json, packages/cli/src/daemon/gitWorktree.ts, packages/cli/src/daemon/gitWriteGuard.ts, packages/cli/src/daemon/gitCommit.ts, packages/cli/src/daemon/gitPush.ts, packages/cli/src/daemon/gitRenameBranch.ts, packages/cli/src/daemon/gitCommit.test.ts, packages/cli/src/daemon/gitPush.test.ts, packages/cli/src/daemon/gitRenameBranch.test.ts, packages/cli/src/daemon/machineRpc.ts, packages/cli/src/daemon/machineRpc.test.ts, packages/web/src/sync/machineRpc.ts, packages/web/src/features/git-diff/types.ts, packages/web/src/features/git-diff/live-actions.ts, packages/web/src/features/git-diff/live-actions.test.ts, packages/web/src/features/git-diff/mock-source.ts, packages/web/src/features/git-diff/mock-source.test.ts, packages/web/src/features/git-diff/use-live-git-diff-actions.ts, packages/web/src/features/git-diff/use-live-git-diff-actions.test.ts, packages/web/src/features/git-diff/use-git-panel.ts, packages/web/src/features/git-diff/components/GitDiffPanel.tsx, packages/web/src/features/git-diff/components/GitToolbar.tsx, packages/web/src/features/git-diff/components/CompareAgainstSelect.tsx, packages/web/src/features/git-diff/index.ts, kvy-prd.md, plan.md, CLAUDE.md, docs/features/git-write-actions.md

## Phases

### Phase 1: Phase 1 — Wire schemas for git.commit / git.push / git.renameBranch (additive)

- [x] In packages/wire/src/rpc.ts, next to the existing Git* schemas (lines ~112-179), add: GitCommitParamsSchema = z.object({ idempotencyKey: z.string(), worktree: z.string(), message: z.string(), stageAll: z.boolean().optional() }) and GitCommitResultSchema = z.object({ committed: z.boolean(), commitSha: z.string().optional(), nothingToCommit: z.boolean().optional() }) with z.infer type exports GitCommitParams/GitCommitResult — mirror the doc-comment style of GitDiffParamsSchema (explain: stageAll true → `git add -A` first so the commit includes exactly what the panel's changed-files list shows, including untracked; omitted/false → `git commit -a`, tracked only; nothingToCommit:true with committed:false is the clean no-op outcome, not an error). Drop amend? from the proposal — no UI consumes it and additive-only means it can land later.
- [x] Add GitPushParamsSchema = z.object({ idempotencyKey: z.string(), worktree: z.string(), remote: z.string().optional(), branch: z.string().optional(), force: z.boolean().optional(), setUpstream: z.boolean().optional() }) and GitPushResultSchema = z.object({ ok: z.literal(true), remote: z.string(), branch: z.string(), forced: z.boolean() }). Doc comment MUST state: force:true maps to --force-with-lease, never raw --force — the raw flag is deliberately unreachable over the wire (data-loss containment).
- [x] Add GitRenameBranchParamsSchema = z.object({ idempotencyKey: z.string(), worktree: z.string(), to: z.string(), from: z.string().optional() }) and GitRenameBranchResultSchema = z.object({ ok: z.literal(true), branch: z.string(), hadUpstream: z.boolean() }). Doc comment: rename is local-only (git branch -m); hadUpstream tells the UI to warn that the remote branch keeps its old name until the next push.
- [x] Register all six new schemas in packages/wire/src/__tests__/schemaRegistry.ts (same wire.X pattern as GitStatusParamsSchema at lines 29-35).
- [x] Regenerate the fixture: pnpm --filter @kvy/wire exec tsx scripts/snapshot-shapes.ts (never hand-edit wire-shapes.json). Note: additiveOnly.test.ts only WARNS about unfrozen schemas, so this step must not be skipped on the grounds that tests pass.
- [x] Add parse round-trip tests for the six schemas in packages/wire/src/rpc.test.ts following the existing Git* test style (valid parse, missing-required-field rejection, unknown-key behavior matching siblings).

**Acceptance:** pnpm --filter @kvy/wire build && pnpm --filter @kvy/wire test pass; the additiveOnly 'not yet in fixture' warning does NOT list any GitCommit*/GitPush*/GitRenameBranch* schema (they are frozen in wire-shapes.json); git diff shows wire-shapes.json changed only by generated additions.

### Phase 2: Phase 2 — Daemon write handlers with registered-workspace authorization

- [x] In packages/cli/src/daemon/gitWorktree.ts, export the currently-private assertSafeBranchName (and keep assertNotCheckedOutElsewhere private — rename does not need it: git allows renaming a branch checked out elsewhere, and rename of the current branch is the primary use). Update its doc comment to note the second consumer (gitRenameBranch.ts).
- [x] Create packages/cli/src/daemon/gitWriteGuard.ts: export type WorktreeAuthorizer = (worktree: string) => Promise<void>; export createRegistryWorktreeAuthorizer(options: RegistryOptions = {}) returning an authorizer that calls workspace/registry.ts's isWithinRegisteredWorkspace(worktree, options) and throws new GitExecError(`worktree is not inside a registered workspace: ${worktree}`) on null. Header comment cites design §12 ('no arbitrary-directory execution from remote') and records the explicit decision that the READ RPCs (git.status/diff/branches) remain ungated for now so existing panels on unregistered worktrees keep working — flagged as a follow-up.
- [x] Create packages/cli/src/daemon/gitCommit.ts modeled line-for-line on gitBranches.ts (injectable deps.git?: GitExec defaulting to gitExec.ts runGit, plus deps.authorizeWorktree?: WorktreeAuthorizer defaulting to createRegistryWorktreeAuthorizer()). handleGitCommit(params: GitCommitParams): (1) await authorizeWorktree(params.worktree); (2) if params.stageAll → git(['add','-A'], worktree); (3) run git(['commit', params.stageAll ? '-m' : '-am', params.message], worktree) — pass message as its own argv element (execFile array form, no shell, so no quoting hazard); (4) on success run git(['rev-parse','HEAD'], worktree) and return {committed:true, commitSha:trimmed}; (5) catch GitExecError whose message matches /nothing (added )?to commit|working tree clean/ and return {committed:false, nothingToCommit:true} — every other error rethrows (throw-through contract, no silent fallback).
- [x] Create packages/cli/src/daemon/gitPush.ts, same deps shape. handleGitPush: (1) authorizeWorktree; (2) resolve branch = params.branch ?? trimmed output of git(['rev-parse','--abbrev-ref','HEAD'], worktree) (reject 'HEAD' — detached — with GitExecError); validate branch and params.remote with the exported assertSafeBranchName-style guard (non-empty, no leading '-', no '..' segment) so neither can be parsed as a git option; (3) remote = params.remote ?? 'origin'; (4) args = ['push', ...(params.force ? ['--force-with-lease'] : []), ...(params.setUpstream ? ['-u'] : []), remote, branch]; NEVER emit raw --force; (5) return {ok:true, remote, branch, forced: params.force === true}. Header comment records the no-credential-management decision: push auth is the machine's ambient git credential helper/SSH agent; failures surface as GitExecError with git's own stderr.
- [x] Create packages/cli/src/daemon/gitRenameBranch.ts, same deps shape. handleGitRenameBranch: (1) authorizeWorktree; (2) assertSafeBranchName(params.to) and, when given, params.from; (3) capture hadUpstream by running git(['for-each-ref','--format=%(upstream:short)', `refs/heads/${from ?? currentBranch}`], worktree) (resolve currentBranch via rev-parse --abbrev-ref HEAD when from omitted) and checking non-empty output; (4) git(['branch','-m', ...(params.from ? [params.from] : []), params.to], worktree); (5) return {ok:true, branch: params.to, hadUpstream}. Header comment notes the rename is local-only and the concurrency decision (no resource-keyed guard — git's ref locks serialize; losers get GitExecError).
- [x] Unit tests gitCommit.test.ts / gitPush.test.ts / gitRenameBranch.test.ts using fake GitExec fns (copy gitBranches.test.ts's pattern): assert exact argv sequences per flag combination (stageAll on/off, force→--force-with-lease, setUpstream, from omitted), authorization rejection (authorizeWorktree throws → handler rejects and git fake is never called), nothingToCommit mapping, detached-HEAD push rejection, unsafe branch/remote/to rejection, and throw-through of arbitrary GitExecError.
- [x] Test createRegistryWorktreeAuthorizer against a temp-homeDir registry (registry.ts's RegistryOptions seam, same pattern as workspace/registry.ts's own tests): registered path passes, nested path passes, unregistered path throws, nonexistent path throws.

**Acceptance:** pnpm --filter kvy test passes with the new suites green; grep confirms '--force' (bare) never appears in gitPush.ts's argv construction — only '--force-with-lease'; each new handler rejects before invoking git when the worktree is unregistered (asserted by a test that fails if the git fake was called).

### Phase 3: Phase 3 — Register the RPCs in machineRpc.ts with idempotency replay

- [x] In packages/cli/src/daemon/machineRpc.ts: append "git.commit", "git.push", "git.renameBranch" to MACHINE_RPC_METHODS (line 132); import the three handlers as defaults; add optional MachineRpcDeps entries gitCommit?/gitPush?/gitRenameBranch? with doc comments matching getGitStatus's style (dependency-free real defaults, same precedent as workspace.register).
- [x] Wrap each resolved handler in withIdempotencyCache (exactly like cachedAdoptTake/cachedAdoptMirror at lines 293-294): const cachedGitCommit = withIdempotencyCache(deps.gitCommit ?? handleGitCommit) etc. Add the three entries to the `methods` MethodSpec table (paramsSchema/resultSchema/handle) alongside git.status/diff/branches (lines 358-372).
- [x] Update the module header comment's idempotency inventory (lines ~25-47): git.commit/git.push/git.renameBranch are the first git RPCs that DO need replay caching — a lost ack retry must replay the prior commit's SHA, never mint a second commit; contrast with the read-only siblings' documented exemption.
- [x] machineRpc.test.ts: add dispatch tests for the three methods following the existing git.status/git.diff test pattern (sealed params in → handler called with validated params → sealed result out; invalid params → error box). Add a replay test: two sequential calls with identical idempotencyKey+params invoke the underlying handler ONCE and return identical results; a rejected first attempt is NOT cached (second call re-runs); different params under the same key re-run (the params-JSON key component).
- [x] Verify (test already exists for other methods — extend it) that rpc-register is emitted for the three new m:<machineId>:<method> targets on connect via the MACHINE_RPC_METHODS loop.
- [x] No machineIntegration.ts changes required (the defaults are dependency-free, same as git.status/git.branches — only git.diff needs custom uploadBlob wiring); confirm commands.machineWiring.integration.test.ts still passes untouched.

**Acceptance:** pnpm --filter kvy test && pnpm --filter kvy typecheck pass; the new machineRpc.test.ts replay test proves a duplicated git.commit call reaches the handler exactly once; MACHINE_RPC_METHODS drives registration so no separate registration code was hand-added.

### Phase 4: Phase 4 — Web plumbing: machineRpc client, GitDiffActions seam, panel state + mutations

- [x] packages/web/src/sync/machineRpc.ts: add "git.commit"/"git.push"/"git.renameBranch" to MachineRpcParams (GitCommitParams etc.), MachineRpcResults, and RESULT_SCHEMAS (GitCommitResultSchema etc.) — the three existing git entries at lines 82-84/96-98/111-113 are the template.
- [x] packages/web/src/features/git-diff/types.ts: extend GitDiffActions with commit(worktree, message, opts?: {stageAll?: boolean}): Promise<{committed: boolean; commitSha?: string; nothingToCommit?: boolean}>; push(worktree, opts?: {force?: boolean; setUpstream?: boolean}): Promise<{remote: string; branch: string; forced: boolean}>; renameBranch(worktree, to: string): Promise<{branch: string; hadUpstream: boolean}>; listBranches(worktree): Promise<GitBranchInfo[]> (import GitBranchInfo from @kvy/wire). Update the module header: the panel is no longer read-only; delete the 'no commit/push actions here' sentence.
- [x] live-actions.ts: implement the four new methods on machineRpcToGitDiffActions via rpc.call with crypto.randomUUID() idempotency keys (existing fetchStatus pattern); listBranches calls 'git.branches' and returns result.branches.
- [x] mock-source.ts: implement the four methods against the mock state (commit resolves {committed:true, commitSha:'abc1234'}, push resolves {remote:'origin', branch: MOCK_STATUS.branch, forced:false}, renameBranch echoes {branch: to, hadUpstream:true}, listBranches returns 2-3 GitBranchInfo rows including the current branch) so component tests and standalone review keep working; update mock-source.test.ts.
- [x] use-live-git-diff-actions.ts: add the four methods to pendingGitDiffActions()'s notReady surface (it must stay structurally complete or the DEK-pending state breaks at compile time).
- [x] use-git-panel.ts: (a) add compareRef state — const [compareRef, setCompareRef] = useState<string | null>(null) where null = 'workspace default' (omit baseRef so daemon-side configured-base-ref fallback still applies) and any string (including 'HEAD') is passed as baseRef; include compareRef in the diff queryKey (["git-diff", worktree, selectedPath, compareRef]) and in the fetchDiff options; (b) add a branches useQuery (["git-branches", worktree], actions.listBranches, enabled on statusQuery.isSuccess); (c) add three useMutations (commit/push/renameBranch — copy features/session-control Composer's useMutation shape) each invalidating queryClient.invalidateQueries({queryKey: ["git-status", worktree]}) and ({queryKey: ["git-diff", worktree]}) (prefix match) — rename also invalidates ["git-branches", worktree]; expose mutation states (isPending, error, and commit's nothingToCommit outcome) from the hook's return object. The compareRef→fetchDiff-options mapping was pulled into its own pure `git-diff-query.ts` module (`buildDiffFetchOptions`) so it's unit-testable without a DOM.
- [x] Extend the existing hook/adapter tests (use-live-git-diff-actions.test.ts, live-actions.test.ts, __tests__) for the new methods: correct RPC method names + param mapping (force flag pass-through, stageAll default), and mutation-triggered invalidation of the status+diff keys.

**Acceptance:** pnpm --filter @kvy/web typecheck && pnpm --filter @kvy/web test pass (both green); a live-actions test asserts push({force:true}) sends {force:true} on the 'git.push' wire call and commit defaults stageAll:true (both present in live-actions.test.ts). a use-git-panel test proves a successful commit invalidates the git-status/git-diff queries (spies on queryClient.invalidateQueries — present in use-git-panel.test.ts). Known gap, called out honestly: "changing compareRef refetches the diff with a new baseRef" is NOT proven via an interactive re-render — this package's vitest config runs environment:"node" with no jsdom/@testing-library/react wired up anywhere in the repo (confirmed: no such dependency in packages/web/package.json), and `renderToStaticMarkup` never flushes effects/subscriptions, so a real "state changes -> query refetches" browser behavior can't be driven from this test suite (matching the precedent in `use-live-git-diff-actions.test.ts`'s and `use-session-lifecycle.test.ts`'s own doc comments). Instead, the compareRef -> fetchDiff-options derivation was extracted into a pure, directly-tested function (`git-diff-query.ts`'s `buildDiffFetchOptions`, exercised by `git-diff-query.test.ts`) proving the mapping is correct; the actual "changing state re-fires the query" wiring is standard `@tanstack/react-query` behavior (queryKey includes compareRef) and would need a live/browser (or jsdom+testing-library) pass to observe directly — left for the next stage.

### Phase 5: Phase 5 — Toolbar UI (rename, commit, push, force-push confirm, compare-against) + docs

- [x] Create packages/web/src/features/git-diff/components/GitToolbar.tsx: a horizontal bar showing (a) BranchName inline-rename — renders status.branch as a button; clicking swaps to a controlled <Input> (components/ui/input) prefilled with the name; Enter commits via the renameBranch mutation, Escape cancels; while isPending show components/ui/spinner; on success with hadUpstream:true show a muted one-line note 'remote branch keeps its old name until you push'; (b) ahead/behind counts from status (already in GitStatusSnapshot); (c) commit area — <Textarea> for the message plus a Commit button (disabled when message is empty or mutation pending), a 'include untracked' checkbox bound to stageAll defaulting checked, and a muted 'Nothing to commit' inline result when nothingToCommit comes back; (d) Push button (plain push) and Force Push button — Force Push opens components/ui/dialog with explicit copy ('Force push uses --force-with-lease; it can still discard commits others pushed. Continue?') and a destructive-variant confirm; (e) every mutation error surfaces the raw GitExecError message inline (text-destructive) — this is the credential-failure UX: git's own stderr, not a Kvy abstraction. The inline-rename/commit-submit decision logic was pulled into a pure `git-toolbar-state.ts` module (`resolveBranchRenameSubmit`/`resolveCommitSubmit`) for direct unit testing.
- [x] Create packages/web/src/features/git-diff/components/CompareAgainstSelect.tsx: a components/ui/select (or dropdown-menu) with options 'Workspace default' (compareRef=null), 'HEAD (uncommitted)' ('HEAD'), each local branch from the branches query (disable none — comparing against the current branch is legal), plus a 'Custom ref…' item revealing a free-text <Input> accepting any branch/tag/SHA; client-side reject empty or '-'-prefixed input (mirror daemon isSafeRevision) before calling setCompareRef; an invalid ref still fails safely server-side as GitExecError shown in the diff error slot. Same pure-module split: `compare-against-select-state.ts` (`isSafeCompareRef`/`resolveSelectValue`/`resolveSelectChange`/`resolveCustomRefSubmit`).
- [x] Wire both into GitDiffPanel.tsx above the existing grid (toolbar row spanning both columns), passing the enlarged useGitPanel return through; keep the read-only rendering path intact when mutations are idle. Update GitDiffPanel's header comment (no longer read-only). Decision recorded: the toolbar lives in the shared GitDiffPanel so the existing /session/[id]/git/ SessionGitScreen gets it for free — no separate timeline-sidebar variant in this feature.
- [x] Export new components from features/git-diff/index.ts; add component tests following SessionGitScreen.test.ts's pattern. Real, direct coverage: `git-toolbar-state.test.ts` proves the rename-submit resolves the typed name (and no-ops on empty/unchanged); `compare-against-select-state.test.ts` proves `-`-prefixed and empty custom refs are rejected; `git-toolbar-state.test.ts`'s `resolveCommitSubmit` proves stageAll passes through matching the checkbox state. `GitToolbar.test.tsx`/`CompareAgainstSelect.test.tsx` add a markup smoke-test layer (branch button, commit box, checkbox default-checked, Push/Force Push buttons render; no mutation fires merely from mounting). Honest gap: "Force Push does NOT fire until the dialog confirm is clicked" is NOT proven by clicking a real dialog open — Radix's `Dialog.Content` only renders while `open`, and this package has no jsdom/`@testing-library/react` anywhere (confirmed: not a dependency in packages/web/package.json) to simulate the click that would open it. The two-step structure (a button that only calls `setForcePushOpen(true)`, with `push({force:true})` reachable ONLY from the dialog's own confirm button's onClick — see GitToolbar.tsx) is a static code-structure guarantee, not a click-tested one; a live/browser pass is needed to observe it directly.
- [x] Docs: kvy-prd.md FR-7.7 — update the '[P2] fast-follow' sentence: commit/push/rename/compare-against are now shipped (PR-via-gh remains [P2]); plan.md §16 '4.1 Git panel' — append the write-actions tasks as completed items; CLAUDE.md — update the cli and web package descriptions (git write RPCs + toolbar, and fix the stale 'no live apiSocket wired' claim for git-diff which use-live-git-diff-actions.ts already obsoleted); create docs/features/git-write-actions.md as this plan's running checklist (phases, decisions — worktree-auth scope, --force-with-lease-only, stageAll default, ephemeral compare-ref, deferred workspace.setGitConfig / read-RPC gating / PR creation).
- [x] Full-repo gate: pnpm build && pnpm typecheck && pnpm test && pnpm lint from the repo root. `build`/`typecheck`/`test` all pass clean, repo-wide (turbo: 11/11 tasks; kvy 140 files/1596 tests, @kvy/web 110 files/846 tests, @kvy/server 43 files/316 tests, all green). `pnpm lint` does NOT pass clean repo-wide — but the ~107 pre-existing errors it reports (`packages/cli/scripts/provider-contract-test.ts`'s `noConsole`, `packages/cli/src/api/outbox.test.ts`'s `noNonNullAssertion`, etc.) are in files this feature never touched (confirmed via `git log -1 -- <file>`, all last modified by unrelated prior commits) — pre-existing repo-wide lint debt, not a regression introduced here. Every file this feature added or modified was checked in isolation (`biome check <the exact file list>`) and is clean (one unrelated pre-existing warning surfaced in `UnifiedDiffViewer.tsx`, a file this feature never edited).

**Acceptance:** Root pnpm build/typecheck/test all pass clean; `pnpm lint` has pre-existing, unrelated repo-wide failures this feature did not introduce (see above) — every file this feature touches is independently lint-clean. Component tests prove the branch-rename/commit-submit/compare-ref-rejection logic directly via pure state modules, plus a markup smoke-test layer for the components themselves; the force-push confirm *gate* is a static code-structure guarantee (no jsdom/`@testing-library/react` in this repo to click-test it — a documented, honest gap for a live/browser pass). The /session/[id]/git/ route renders the toolbar (verified: `next build`'s static export succeeded and its route bundle size grew from 25.7kB to 28.8kB after adding GitToolbar/CompareAgainstSelect, plus the SessionGitScreen/GitDiffPanel tests still pass). kvy-prd.md, plan.md, CLAUDE.md and this doc all reflect shipped state.


## Status

**All five phases implemented and verified.** `pnpm build && pnpm typecheck && pnpm test` all
pass clean, repo-wide (kvy: 140 test files / 1596 tests; `@kvy/web`: 110 test files / 846
tests; `@kvy/server`: 43 test files / 316 tests — none of this feature's changes touch
`@kvy/server`, its suite is included only because it's part of the root gate).

- **Phase 1 (wire schemas):** `GitCommitParams/Result`, `GitPushParams/Result`,
  `GitRenameBranchParams/Result` added to `packages/wire/src/rpc.ts`, registered in
  `schemaRegistry.ts`, frozen in `wire-shapes.json` (regenerated via `snapshot-shapes.ts`, never
  hand-edited), with parse round-trip tests in `rpc.test.ts`.
- **Phase 2 (daemon handlers):** `gitWriteGuard.ts` (registered-workspace authorizer, design
  §12), `gitCommit.ts`/`gitPush.ts`/`gitRenameBranch.ts`, each with a full unit-test suite
  (argv-exact assertions, unsafe-ref rejection, authorization-gate rejection, throw-through of
  arbitrary `GitExecError`). `force` maps ONLY to `--force-with-lease` — confirmed via grep that
  bare `--force` never appears in `gitPush.ts`'s argv construction.
- **Phase 3 (machineRpc registration):** all three RPCs registered in `machineRpc.ts`,
  idempotency-cached via the existing `withIdempotencyCache` (the first git RPCs that need
  replay caching), with dispatch + replay tests in `machineRpc.test.ts`.
- **Phase 4 (web plumbing):** `sync/machineRpc.ts`, `GitDiffActions` (`types.ts`/
  `live-actions.ts`/`mock-source.ts`/`use-live-git-diff-actions.ts`), and `use-git-panel.ts`
  (compareRef state, a `git.branches` query, three `useMutation`s invalidating status/diff/
  branches on success) all updated and tested. The `compareRef` → `fetchDiff` options mapping
  was pulled into a pure `git-diff-query.ts` module for direct testability.
- **Phase 5 (toolbar UI + docs):** `GitToolbar.tsx` (inline rename, commit, push, force-push
  confirm dialog) and `CompareAgainstSelect.tsx` (workspace default / HEAD / branch / custom
  ref), each backed by a pure state module (`git-toolbar-state.ts`,
  `compare-against-select-state.ts`) for direct unit testing, wired into `GitDiffPanel.tsx`.
  kvy-prd.md, plan.md, and CLAUDE.md updated to reflect shipped state (including correcting a
  stale "no live apiSocket wired" claim for the git-diff feature that `use-live-git-diff-actions.ts`
  had already obsoleted before this feature started).

**Known, honest gaps** (this package has no jsdom/`@testing-library/react` wired up anywhere —
confirmed, not a dependency in `packages/web/package.json` — so no test in this repo can
simulate a real click/keystroke; every gap below follows directly from that one constraint,
matching the precedent already set by `use-session-lifecycle.test.ts`/
`take-over-dialog-state.ts`):
- "Changing `compareRef` re-fetches the diff with the new `baseRef`" is proven at the pure-logic
  level (`git-diff-query.test.ts`'s `buildDiffFetchOptions`), not via an interactive re-render.
- "Force Push doesn't fire until the confirm dialog is clicked" is a static code-structure
  guarantee (only the dialog's own confirm button's `onClick` can reach `push({force:true})`),
  not a click-tested one.
- Both would need a live/browser (or jsdom + `@testing-library/react`) pass to observe directly
  — left for the next stage / a manual QA pass before this ships to real users.

**`pnpm lint`** does not pass clean at the repo root — but the ~107 errors it reports are
pre-existing, repo-wide lint debt in files this feature never touched (verified via
`git log -1 -- <file>` on a sample: `packages/cli/scripts/provider-contract-test.ts`,
`packages/cli/src/api/outbox.test.ts`, etc., all last modified by unrelated prior commits — not
introduced by this work). Every file this feature added or modified was checked in isolation
(`biome check` scoped to exactly that file list) and is lint-clean.

Merged into v2-pty-injection at c41777764496fc9cc8c04851aff3315959ca54d3.

## Test & Review notes

Independent verification pass (separate agent, worktree `.worktrees/feature-git-write-actions`).
Ran `pnpm build && pnpm typecheck && pnpm test` repo-wide (all green as reported: kvy
140 files/1596 tests, `@kvy/web` 110 files/846 tests, `@kvy/server`/e2e cached-clean), then
verified each phase's acceptance criteria against the real code rather than trusting the
checkboxes — reading every new daemon handler/wire schema/web module, re-confirming the
`--force-with-lease`-only grep, the registry-authorization gate (unit tests + a real temp-repo
integration script), the idempotency-cache replay tests, and the toolbar/select pure-state
modules. Two real bugs were found and fixed (both re-tested, full suite re-run green after each):

1. **The credential-failure/error-message UX the whole feature is built around didn't actually
   work.** `daemon/machineRpc.ts`'s `onRpcRequest` caught every handler error (`GitExecError`
   included) and replaced it with a hardcoded literal `"handler-error"` string before sealing the
   response — so no caller could ever see git's own stderr, no matter what `gitPush.ts`/
   `gitCommit.ts` threw. Compounding it, the web `sync/machineRpc.ts` client never checked for
   that `{ok:false, error}` shape in the *decrypted* result before running it through the
   method's result-schema `safeParse` (which can only ever fail for an error box, since a real
   success result never has an `ok` field) — so even a correctly-forwarded message would have
   been discarded again and replaced with a second, generic `"'method' RPC result failed schema
   validation"` string. `gitPush.test.ts`'s own "e.g. no credentials configured" test
   demonstrated this without the implementer noticing: it asserts `error: "handler-error"` for a
   thrown `"fatal: could not read Username"` — i.e. the test that was supposed to prove the
   credential-failure UX instead pinned the bug. Fixed both ends: the daemon now seals the
   handler's real `error.message` (all 13 existing "handler-error"-literal assertions across
   `machineRpc.test.ts`/`machineRpc.takeoverRace.test.ts` updated to their actual thrown
   messages, since this is shared dispatch code used by every machine RPC, not just git's), and
   the web client checks the inner error-box shape before schema validation (new regression test
   in `sync/__tests__/machineRpc.test.ts`). This also fixes the same, previously-broken error
   surfacing for the pre-existing read-only `git.status`/`git.diff`/`git.branches` (and every
   other machine RPC) — not just the new write actions.
2. **`gitCommit.ts`'s "nothing to commit" detection was unreachable in real usage.** Verified by
   actually driving the real handlers against a live scratch git repo + a local bare "remote"
   (never this repo's own origin — see the safety constraints this review operates under): a
   real `git commit` on a clean tree writes "nothing to commit, working tree clean" to **stdout**
   and exits non-zero, but `daemon/gitExec.ts`'s `runGit` only ever captured `stderr` for the
   `GitExecError` message, falling back to Node's generic `"Command failed: git commit -m ..."`
   wrapper text when stderr was empty — so `gitCommit.ts`'s `NOTHING_TO_COMMIT_RE` could never
   match against real git output; every unit test that exercised it did so by hand-constructing
   a `GitExecError` with the right text directly, never through the real stdout/stderr capture
   that produces it. Fixed `runGit` to fall back to stdout (then `error.message`) when stderr is
   empty, and added `daemon/gitExec.test.ts` — the first test file in this module that spawns the
   real `git` binary against a real temp repo (init/config/commit, a `fatal: not a git
   repository` case confirming stderr-based errors are unaffected, and the stdout-only
   "nothing to commit" case this bug was about). Re-ran the full real-repo drive afterward
   (commit → nothing-to-commit → push → rename → push renamed branch → force-push-with-lease →
   rejected-unauthorized-worktree) end-to-end against the scratch repo/remote and confirmed the
   bare remote actually received the renamed branch and both commits.

Everything else held up: the wire schemas are genuinely additive and frozen in
`wire-shapes.json`; `gitWriteGuard.ts`'s registered-workspace authorization rejects before any
`git` invocation (verified both via the existing unit tests and the real drive script's
unauthorized-`/tmp` case); `gitPush.ts` never emits bare `--force` (grep-confirmed); the
`withIdempotencyCache` replay tests genuinely prove single-invocation-per-key semantics; and the
web toolbar/compare-ref pure-state modules (`git-toolbar-state.ts`,
`compare-against-select-state.ts`, `git-diff-query.ts`) correctly implement everything their
acceptance notes claim. The two honestly-flagged jsdom/`@testing-library/react` gaps (compareRef
re-fetch, force-push dialog gating) are real repo-wide constraints, not something this review
could close, and are left as-is per the plan's own notes.

No unresolved issues — both bugs found were fixed and re-verified in this same worktree.
