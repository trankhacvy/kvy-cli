# Per-workspace Setup/Run scripts (docs/competitive-notes-omnara.md #7)

**Slug:** `setup-run-scripts` · **Branch:** `wf/feature-setup-run-scripts` · **Target:** `v2-pty-injection`

## Feature description

Per-workspace Setup/Run scripts. Workspace settings has a persisted "Setup script" (runs on every new worktree creation, e.g. `npm install`) and "Run script" (one-click launch via a play button, e.g. `npm run dev`) — a full bootstrap-and-run lifecycle tied to session/worktree creation, feeding directly into the Preview tunnel above.

## Solution (Opus 4.8)

Feature #7 "Per-workspace Setup/Run scripts" splits cleanly into three grounded sub-problems that map onto patterns already in the codebase, plus one genuinely new subsystem:

(A) PERSISTENCE — where the two script strings live. There is already a per-workspace config store: `packages/cli/src/workspaceConfig.ts` persists `WorkspaceGitConfig {baseRef?, remote?}` into `settings.json`'s `workspaces` map, keyed by the symlink-resolved real path (`resolveWorkspaceKey`). The right move is to EXTEND that shape additively to `{baseRef?, remote?, setupScript?, runScript?}` rather than invent a new file. This reuses its atomic lock-file read-modify-write for free and lands on the same key convention as `workspace/registry.ts`. (Rename the concept from "git config" to "workspace config" — the store is already general.) The CLI command `commands/workspaceConfig.ts` gains `--setup-script`/`--run-script` flags, matching the existing `--base-ref`/`--remote` precedent.

(B) SETUP SCRIPT — "runs on every new worktree creation." The exact hook point already exists: `spawnEngine.ts` calls `ensureBranchWorkspace(...)` (gitWorktree.ts) at line ~222, which resolves `params.branch` into the launch directory. Today it returns `{directory}`; it must also return whether it *created a fresh worktree* vs reused an existing one vs checked out in place — add `{directory, createdWorktree: boolean}` (gitWorktree.ts already knows this: the `alreadyThere` early-return vs the `git worktree add` path). Then `spawnEngine` runs the setup script only when `createdWorktree === true`, in the new worktree dir, before (or alongside) the provider launch. A new `daemon/setupScript.ts` reads the workspace config and executes the script via a shell.

(C) RUN SCRIPT — "one-click launch via a play button, e.g. `npm run dev`." This is the genuinely new subsystem: a long-lived, remotely start/stop-able managed process that is NOT a provider session. It needs (1) new `run.start`/`run.stop`/`run.status` machine RPCs (or the reserved `preview:*` namespace — design §14/plan.md §16 already reserve it), (2) a small run-process registry in the daemon distinct from `sessionRegistry.ts` (which is provider-session-only), and (3) a web UI "Setup/Run" panel in the session sidebar. The run process should reuse `processLauncher.ts`'s tmux-preferred launch — tmux is ideal here: the dev server survives daemon restarts, the user can `tmux attach`, and it gives a stable pane pid to track/kill.

(D) REMOTE CONFIG SURFACE — currently the per-workspace config has NO remote surface at all (`falcon workspace config` is CLI-only, explicitly "no daemon interaction"). For the web Workspace Settings UI to read/edit the scripts, add `workspace.getConfig`/`workspace.setConfig` machine RPCs, gated on the registered-workspace authorizer (`gitWriteGuard.ts`).

Web side mirrors the established feature-area pattern (git-diff, repo-files, checks): a new `src/features/run-panel/` with an injectable `live-actions.ts` (→ real machineRpc) vs `mock-source.ts` seam, a `use-run-panel.ts` TanStack hook, and a new "Setup / Run" tab on `/session/[id]`. `sync/machineRpc.ts` gains the new methods.

EXISTING PATTERNS TO REUSE (do not reinvent):
- Per-workspace config store already exists (workspaceConfig.ts → settings.json `workspaces` map, real-path-keyed, atomic locked RMW). Extend `WorkspaceGitConfig` additively; do NOT create a new file.
- Mutating-RPC security gate already exists: `gitWriteGuard.ts`'s `createRegistryWorktreeAuthorizer` / `isWithinRegisteredWorkspace`. Every write/exec RPC here (`workspace.setConfig`, `run.start`, setup-script exec) must gate on it — this is the design §12 "no arbitrary-directory execution from remote" invariant.
- Long-lived launch already exists: `processLauncher.ts`'s `launchProviderProcess` (tmux-preferred, detached fallback, returns pane pid). Run script should reuse it; note it currently spawns argv (no shell) — script strings are free-form and need `sh -c <script>` / `cmd /c`, a new shell-invocation path.
- Machine RPC registration is a well-worn table: add methods to `MACHINE_RPC_METHODS` in `machineRpc.ts`, add injectable `deps.*` handlers defaulting to real modules, wire caller-side in web `sync/machineRpc.ts`. There are already ~19 methods following this exact shape (git.commit/git.push are the closest mutating templates — see gitCommit.ts).
- Wire schemas are additive-only and frozen against a fixture (`__tests__/additiveOnly.test.ts`, `schemaRegistry.ts`, `schemaShape.ts`) — new params/result schemas must be registered and must not retype existing fields.

KEY DEPENDENCIES / SEQUENCING:
- worktree-isolation (#2) is ALREADY LANDED (gitWorktree.ts, SpawnParams.branch, git.branches RPC, Settings→Git default) — the setup-script hook has a real home. Good.
- Preview tunnel (#6, dev-server-preview) is NOT built. Feature #7 "feeds directly into the Preview tunnel." Recommend building run.* to expose the running process (and, later, detected ports) but treating the actual tunnel as the separate deferred #6 — the `preview:*` reserved namespace is where that connects. Don't couple run-script delivery to a tunnel that doesn't exist.

DATA-MODEL / STATE QUESTIONS (decide in planning):
- Is a running run-script instance keyed by session, by worktree directory, or by workspace? Omnara surfaces it inside a live session's Setup/Run panel → recommend keying by the session's *directory* (the worktree), one run process per directory, so two sessions on the same worktree share/conflict predictably.
- Run-process registry: new module (`daemon/runProcessRegistry.ts`) vs bolting onto sessionRegistry. Recommend separate — sessionRegistry is tightly typed to `TrackedSession`/provider semantics and persisted for adoption; a run process is a different lifecycle. But it SHOULD persist enough (tmux session name + dir) to survive daemon restart and re-adopt, mirroring sessionRegistry's boot re-adoption.
- Output/log streaming: does run-script stdout stream to web (dev-server logs are the whole point)? Options: a new `run.logs` stream, reuse the eventRouter ephemeral channel, or "attach via tmux only for now." Flag as undecided.

## Plan (Fable 5)

Per-workspace Setup/Run scripts, built in six phases on verified existing patterns: (1) additively extend the existing settings.json workspaces store (workspaceConfig.ts) with setupScript/runScript and expose them via the existing `falcon workspace config` CLI flags — script DEFINITION is terminal-only, preserving design §12's local-consent boundary; (2) make gitWorktree.ts report createdWorktree and hook a fire-and-forget, never-blocking setup-script runner into spawnEngine.ts (async is mandatory: the RPC pipeline's 30s/35s ack timeouts forbid blocking on npm install), with status persisted to a new run-state store; (3) a new daemon run-process subsystem — shell-argv helper, persisted run-state store with lazy on-demand liveness probing (no boot task needed), and run.start/run.stop/run.status/run.setup handlers that reuse launchProviderProcess (tmux-preferred) unchanged and gate every call on the registered-workspace authorizer, resolving config through the CONTAINING workspace root (worktree dirs are not config keys — a subtlety the original proposal missed); (4) register five new machine RPCs (workspace.getConfig read-only + the four run.*) in machineRpc.ts/machineIntegration.ts with idempotency caching and a directory-keyed in-flight guard, plus wire schemas frozen into the additive-only fixture; (5) a web features/run-panel/ area + /session/[id]/run route mirroring the git-diff feature's injectable mock/live seam, with play/stop buttons, setup status, and a polled log tail; (6) docs + full-pipeline verification. run.* is deliberately decoupled from the unbuilt preview:* tunnel namespace.

**Risks:** Remote-triggered arbitrary code execution is the central risk: run.start/run.setup execute free-form shell strings on the host. Mitigated by (a) definition being CLI-only — the RPC never carries a script string, only a worktree path; (b) every handler gating on isWithinRegisteredWorkspace; (c) execution under the daemon's own uid with inherited env, no escalation. Any future workspace.setConfig RPC would reopen this and needs its own consent design — implementers must not add it opportunistically.; Async setup means the agent session starts before dependencies are installed — the agent may run failing npm commands during the install window. Accepted consequence of the hard 30s RPC timeout; surfaced via the run panel's setup status, but a confusing first-session experience is possible.; PID-recycling false positives: a persisted detached-method pid probed with process.kill(pid,0) after a machine reboot can match an unrelated process, making run.status report 'running' and run.stop kill an innocent process. tmux-method entries are safe (has-session by name). Mitigation to implement: treat a pid probe as live only when startedAt is plausible, or prefer the tmux path; at minimum flag detached-method staleness in runStateStore's doc comment.; Windows support of shellCommand's cmd.exe /c path and the '>> log 2>&1' redirect wrapper is untested in this codebase (no Windows CI); the tmux path never applies there, so Windows always takes the weakest (detached, pid-probe) branch.; The log-redirect wrapper makes the tmux pane blank — users who tmux attach expecting dev-server output will see nothing. Deliberate tradeoff for a single log source; must be documented in the run panel and module comments.; Two sessions sharing one worktree share one run process by design (directory keying) — stopping it from one session's panel stops it for the other; port conflicts are avoided but the shared-control UX may surprise users.; The wire additive-only fixture is append-only forever: the ten new schemas' shapes are frozen at first release, so RunStatusResult's state enums must be right the first time (new enum members are additive-compatible only if the frozen-shape comparator treats enum widening as compatible — verify schemaShape.ts's rules before finalizing enums).; The web run panel ships behind the same injectable mock seam as every other feature area (no live apiSocket/per-machine crypto wiring exists yet anywhere) — the feature is not end-to-end operable from a browser until the separate sync-engine/crypto wiring task lands; stakeholders should not expect a clickable production flow from this feature alone.; Setup-script kickoff inside spawnSession is fire-and-forget with no caller awaiting rejections — the runner must guarantee it never throws synchronously and always records a terminal state, or a silent unhandled rejection could hide setup failures entirely.
**Files likely touched:** packages/wire/src/rpc.ts, packages/wire/src/index.ts, packages/wire/src/__tests__/schemaRegistry.ts, packages/wire/src/__tests__/additiveOnly.test.ts (frozen shape fixture it reads), packages/cli/src/workspaceConfig.ts, packages/cli/src/persistence.ts, packages/cli/src/commands/workspaceConfig.ts, packages/cli/src/args.ts, packages/cli/src/index.ts, packages/cli/src/daemon/gitWorktree.ts, packages/cli/src/daemon/spawnEngine.ts, packages/cli/src/daemon/shellCommand.ts (NEW), packages/cli/src/daemon/setupScript.ts (NEW), packages/cli/src/daemon/runStateStore.ts (NEW), packages/cli/src/daemon/runProcess.ts (NEW), packages/cli/src/daemon/workspaceConfigRpc.ts (NEW), packages/cli/src/daemon/machineRpc.ts, packages/cli/src/daemon/machineIntegration.ts, packages/web/src/sync/machineRpc.ts, packages/web/src/features/run-panel/ (NEW: types.ts, mock-source.ts, live-actions.ts, use-run-panel.ts, components/RunPanel.tsx, index.ts, __tests__/), packages/web/src/app/(protected)/session/[id]/run/page.tsx (NEW), packages/web/src/components/timeline/ (session header — add Run tab link), CLAUDE.md, docs/features/setup-run-scripts.md (NEW — this plan)

## Phases

### Phase 1: Phase 1 — Wire schemas + config-store extension + CLI definition surface

- [x] In packages/wire/src/rpc.ts add and export: WorkspaceGetConfigParamsSchema { worktree: z.string() } / WorkspaceGetConfigResultSchema { baseRef?, remote?, setupScript?, runScript? — all z.string().optional() }; RunStartParamsSchema { idempotencyKey: z.string(), worktree: z.string() } / RunStartResultSchema { started: z.boolean(), alreadyRunning: z.boolean().optional(), method: z.enum(['tmux','detached']).optional(), pid: z.number().optional(), tmuxSessionName: z.string().optional() }; RunStopParamsSchema { idempotencyKey, worktree } / RunStopResultSchema { stopped: z.boolean(), wasRunning: z.boolean() }; RunStatusParamsSchema { worktree } / RunStatusResultSchema { run: { state: z.enum(['running','stopped','none']), pid?, method?, startedAt? (number), logTail? (string) }, setup: { state: z.enum(['not-run','running','succeeded','failed']), exitCode? (number), startedAt?, finishedAt?, logTail? } }; RunSetupParamsSchema { idempotencyKey, worktree } / RunSetupResultSchema { started: z.boolean(), alreadyRunning: z.boolean().optional() }. Follow GitCommitParamsSchema (rpc.ts:307) as the doc-comment/style template — every mutating params schema carries idempotencyKey.
- [x] Export the new schemas/types from packages/wire/src/index.ts; add every new schema to packages/wire/src/__tests__/schemaRegistry.ts and add matching entries to the frozen shape fixture the additiveOnly.test.ts 'every schema in the registry is covered by the frozen fixture' assertion reads (follow how the last-added schemas, e.g. ProviderAccount*, were frozen).
- [x] In packages/cli/src/workspaceConfig.ts add setupScript?: string and runScript?: string to WorkspaceGitConfig; give setWorkspaceGitConfig explicit clear semantics: a field set to the empty string in the patch DELETES that key from the stored config (document it in the doc comment). Update packages/cli/src/persistence.ts if the Settings.workspaces value type is declared there so the new fields typecheck.
- [x] In packages/cli/src/commands/workspaceConfig.ts add setupScript?/runScript? to WorkspaceConfigCommandOptions, include them in hasPatch/patch construction, and extend formatConfig to print 'setup script:'/'run script:' lines ('(none)' when unset). In packages/cli/src/args.ts add --setup-script <script> and --run-script <script> flag parsing for the workspace config subcommand, mirroring --base-ref/--remote exactly, and thread through packages/cli/src/index.ts if the options object is built there.
- [x] Extend existing unit tests: workspaceConfig store round-trip with the two new fields including the empty-string-clears behavior; the workspace-config command test asserting the new flags persist and print; run pnpm --filter @falcon/wire test to prove the additive-only suite passes with the new registrations.

**Acceptance:** pnpm --filter @falcon/wire test passes (additiveOnly suite green with all 10 new schemas registered AND frozen); pnpm --filter falcon test passes with new workspaceConfig tests proving set/read/clear of setupScript/runScript via both the store API and the CLI command path; root pnpm typecheck green.

### Phase 2: Phase 2 — createdWorktree signal + async setup-script runner hooked into spawn

- [x] Change packages/cli/src/daemon/gitWorktree.ts ensureBranchWorkspace return type to { directory: string; createdWorktree: boolean } — false on the createWorktree:false checkout path (gitWorktree.ts:245) and the alreadyThere reuse early-return (line 254), true only after a real 'git worktree add' (line 263-270). Update its existing unit tests for the new field on all three paths.
- [x] Create packages/cli/src/daemon/shellCommand.ts: buildShellInvocation(script: string): { command: string; args: string[] } returning ['/bin/sh', ['-c', script]] on POSIX and ['cmd.exe', ['/c', script]] on win32 (process.platform injectable for tests). Unit-test both branches.
- [x] Create packages/cli/src/daemon/runStateStore.ts: a persisted ~/.falcon/run-state.json mapping directory realpath key → { run?: { pid, method, tmuxSessionName?, startedAt, logFile, script }, setup?: { state: 'running'|'succeeded'|'failed', exitCode?, startedAt, finishedAt?, logFile } }. Copy sessionsStore.ts's exact durability pattern: tmp-write + rename, per-homeDir in-process write-queue serialization, version-agnostic tolerant reader that never throws on missing/corrupt files. PersistenceOptions-style { homeDir } injection for tests.
- [x] Create packages/cli/src/daemon/setupScript.ts: runSetupScript({ workspaceRoot, directory, homeDir, logger }) — reads readWorkspaceGitConfig(workspaceRoot) (NOTE: the config key is the workspace ROOT, the cwd is the worktree directory); no-op when setupScript unset; otherwise writes setup state 'running' to runStateStore, spawns buildShellInvocation(script) via cross-spawn with cwd=directory, stdout+stderr appended to a fresh-truncated ~/.falcon/logs/setup-<sha256(directory) prefix>.log, and on close records 'succeeded'/'failed' + exitCode + finishedAt. Returns a kickoff result synchronously ({ started: boolean, alreadyRunning?: boolean } — refuse to double-start while a setup for the same directory is in state 'running' with a live pid); NEVER throws and NEVER blocks on script completion. Injectable spawnImpl + clock for tests. (Also added `pid?: number` to the persisted `SetupEntry` — not in the original spec, but needed to actually implement the "live pid" double-start guard the spec calls for.)
- [x] In packages/cli/src/daemon/spawnEngine.ts add optional dep runSetupScript?: (workspaceRoot: string, spawnDirectory: string) => void to SpawnEngineDeps; after ensureBranchWorkspace (line ~222) call it fire-and-forget ONLY when branchResult.createdWorktree === true, before the provider launch, without awaiting. Document in the header comment that this is why a retried spawn (idempotency replay), a reused worktree, and an in-place checkout never re-run setup.
- [x] Unit tests: spawnEngine calls runSetupScript exactly on the created-fresh-worktree path and never on reuse/in-place/no-branch spawns, and spawn resolves without awaiting the setup promise; setupScript state-machine test with a fake spawnImpl covering success, non-zero exit, unset script, and double-start refusal.

**Acceptance:** vitest suites for gitWorktree (new createdWorktree field on all three paths), shellCommand, runStateStore (read/write/corrupt-file tolerance), setupScript (state transitions with fake process), and spawnEngine (hook fires only on genuine worktree creation, spawn latency independent of setup duration) all pass; pnpm --filter falcon test + typecheck green.

### Phase 3: Phase 3 — Daemon run-process subsystem (start/stop/status/setup handlers)

- [x] Create packages/cli/src/daemon/runProcess.ts with a shared resolveRunContext(worktree, options): realpath the input, call workspace/registry.ts's isWithinRegisteredWorkspace — throw a typed error ('worktree is not inside a registered workspace: …', mirroring gitWriteGuard.ts:36) when null, and return { directoryKey, workspaceRoot: entry's registered path }. Every handler below calls this first — it is both the design-§12 auth gate AND the config-key resolver (config lives under the workspace ROOT key; .worktrees/<branch> dirs are never config keys).
- [x] handleRunStart(params: RunStartParams, deps): resolve context; read runScript from readWorkspaceGitConfig(workspaceRoot) — throw 'no run script configured for this workspace' when unset; probe the persisted run entry for directoryKey for liveness (tmux method → 'tmux has-session -t <name>' via injected spawnImpl; detached method → process.kill(pid, 0) probe) and return { started:false, alreadyRunning:true } when live; otherwise launch via the EXISTING launchProviderProcess (processLauncher.ts — unchanged) with sessionLabel 'run-<first 12 hex of sha256(directoryKey)>', command/args from buildShellInvocation wrapping the script as '<script> >> <logFile> 2>&1' (fresh-truncated ~/.falcon/logs/run-<hash>.log; documented tradeoff: the tmux pane shows no output, the log file is the single source both web and tail -f read), cwd=the resolved worktree realpath, env=process.env; persist the run entry (pid, method, tmuxSessionName?, startedAt, logFile, script) and return the RunStartResult.
- [x] handleRunStop(params): resolve context; read the persisted entry — { stopped:false, wasRunning:false } when none/dead; else SIGTERM the pid, poll up to 5s, then SIGKILL (a local copy of kill.ts's escalation loop, injectable isAlive/killRunEntry — kill.ts's own exported killGraceful needs a full ClassifiedProcess+KillDeps shape that doesn't fit a single run entry cleanly, so this is a self-contained equivalent rather than a direct reuse), best-effort 'tmux kill-session -t <name>' for the tmux method, clear the run entry, return { stopped:true, wasRunning:true }.
- [x] handleRunStatus(params): resolve context; return { run: liveness-probed state ('running'|'stopped'|'none') + pid/method/startedAt + logTail (last 4KB of the run logFile, read tolerant of a missing file), setup: the runStateStore setup record mapped to the wire enum ('not-run' when absent) + logTail of the setup log }. Read-only, no idempotency needs.
- [x] handleRunSetup(params: RunSetupParams): resolve context; delegate to Phase 2's setupScript.ts runner with { workspaceRoot, directory: resolved worktree } — returns its { started, alreadyRunning } kickoff result immediately (async contract identical to spawn-time setup; progress observed via run.status).
- [x] Create packages/cli/src/daemon/workspaceConfigRpc.ts: handleWorkspaceGetConfig(params) — resolveRunContext for the auth gate, then readWorkspaceGitConfig(workspaceRoot) mapped to WorkspaceGetConfigResult (empty object when no config). Read-only.
- [x] Unit tests in temp homeDirs with injected fakes: full start→status(running+logTail)→stop→status(stopped) lifecycle; unauthorized (unregistered) worktree rejected by every handler; start with no configured runScript errors; alreadyRunning dedup; stale persisted pid (dead process) reads as stopped and does not block a new start; a second store instance over the same homeDir (simulated daemon restart) still sees and can stop the persisted run entry; worktree-under-.worktrees resolves config from the parent workspace root.

**Acceptance:** vitest suite for runProcess + workspaceConfigRpc passes covering: lifecycle, auth-gate rejection on every handler, no-script error, alreadyRunning dedup, stale-pid recovery, daemon-restart persistence (fresh store instance), and root-vs-worktree config-key resolution; pnpm --filter falcon test + typecheck green.

### Phase 4: Phase 4 — Machine-RPC registration, idempotency/concurrency guards, wiring, web client types

- [x] In packages/cli/src/daemon/machineRpc.ts: add 'workspace.getConfig', 'run.start', 'run.stop', 'run.status', 'run.setup' to MACHINE_RPC_METHODS; add optional deps (getWorkspaceConfig?, runStart?, runStop?, runStatus?, runSetup?) defaulting to the Phase 3 modules; add the five MethodSpec entries with the Phase 1 schemas. Wrap run.start/run.stop/run.setup in withIdempotencyCache (lost-ack retry must replay, mirroring git.commit's rationale — machineRpc.ts:398); leave workspace.getConfig/run.status uncached (read-only, same as git.status). Additionally generalize withProviderSessionGuard (machineRpc.ts:354) into a resource-keyed guard and apply it to run.start keyed on params.worktree — two devices pressing play concurrently with different idempotencyKeys must join one launch attempt. Update the module header comment's method inventory.
- [x] In packages/cli/src/daemon/machineIntegration.ts: bind the five handlers with { homeDir: deps.homeDir, logger: deps.logger } (they need homeDir for runStateStore/logs — same pattern as getGitDiffHandler's uploadBlob binding), pass them into registerMachineRpcHandlers; also bind spawnEngine's new runSetupScript dep inside spawnSessionHandler (and spawnSessionForAdoptTake — harmless there since adoption never creates a worktree) to setupScript.ts's runner with homeDir/logger. Verify daemon/commands.ts's createDaemonCommandDeps needs no change beyond what flows through machineIntegration deps (homeDir already present).
- [x] In packages/web/src/sync/machineRpc.ts: add the five methods to MachineRpcParams, MachineRpcResults, RESULT_SCHEMAS, and the re-exported param types, importing the new @falcon/wire schemas — mechanical, mirroring provider.account's last addition.
- [x] Daemon machineRpc tests: extend the registration test to assert all five new targets are rpc-register'd; add dispatch tests (seal params → handler called with validated params → sealed result opens to the wire shape) for workspace.getConfig and run.start including an idempotency-replay case and a concurrent same-worktree different-key run.start joining one attempt.

**Acceptance:** packages/cli machineRpc.test asserts registration + sealed round-trip dispatch for all five methods, idempotency replay on run.start, and the worktree-keyed concurrent-join; pnpm build && pnpm typecheck && pnpm test green at the repo root (wire, cli, web all compile against the new method tables).

### Phase 5: Phase 5 — Web run panel feature + /session/[id]/run route

- [x] Create packages/web/src/features/run-panel/ mirroring features/git-diff/'s exact seam layout: types.ts (RunPanelActions: getConfig/start/stop/status/setup; RunPanelSnapshot view-model), mock-source.ts (default mock actions: a configured runScript, canned status transitions — the same not-yet-wired default every feature area uses), live-actions.ts (machineRpcToRunPanelActions(client: MachineRpcClient, worktree) mapping straight onto the five new sync/machineRpc.ts methods, minting cuid2 idempotencyKeys per mutation — copy live-actions.ts from git-diff as the template), and index.ts. (Also added use-live-run-panel-actions.ts — a `useLiveRunPanelActions` hook gated on `use-machine-crypto.ts`'s per-machine DEK unwrap, mirroring git-diff/github-checks's own live-actions precedent, since both of those feature areas actually default their panel component to the live hook rather than the mock — matching that established convention here too.)
- [x] use-run-panel.ts: TanStack Query — one query for workspace.getConfig (once per worktree), one for run.status with refetchInterval ~5000ms while run.state==='running' or setup.state==='running' (disabled otherwise); useMutation wrappers for start/stop/setup that invalidate the status query on settle. Unit-test the hook's polling-enable logic and invalidation like use-git-panel.test.ts does.
- [x] components/RunPanel.tsx: play button (disabled with a 'No run script configured — set one from a terminal: falcon workspace config --run-script "npm run dev"' hint when runScript unset), stop button while running, run-state badge, setup section (state badge, exit code on failure, 'Re-run setup' button → run.setup), and a monospace scrollable log-tail block (run log while running, setup log during setup) that updates with the polled status. Follow GitDiffPanel.tsx's composition style; no dangerouslySetInnerHTML. (Split into a pure `RunPanelBody` + thin `RunPanel` wrapper, mirroring ChecksPanel.tsx's own `ChecksBody` extraction, for direct render-testing without a live query/mutation graph.)
- [x] Route packages/web/src/app/(protected)/session/[id]/run/page.tsx mirroring the git/page.tsx wrapper exactly (injectable UseRunPanel seam defaulting to mock-source — same not-yet-live state as every other feature area); add a 'Run' link/tab in the session header next to the existing Files/Git/Checks links (locate the header component referenced by session/[id]/page.tsx and follow the 'Files changed' button precedent). (Added `SessionRunScreen`, a structural clone of `SessionGitScreen`/`SessionChecksScreen`, as the actual route body — resolves the session's real machineId/workspaceId off the live sync snapshot; labeled the header link "Setup / Run".)
- [x] Tests mirroring git-diff's suite: mock-source behavior test, live-actions test (fake MachineRpcClient asserting method names/params/idempotency-key minting), use-run-panel hook test, and a RunPanel component render test for the three key states (no script configured / running with log tail / setup failed).

**Acceptance:** pnpm --filter @falcon/web test and build pass; the new tests prove: /session/[id]/run renders from the mock seam, play is disabled without a configured runScript, live-actions calls run.start/run.stop/run.setup/run.status/workspace.getConfig with correct params and fresh idempotency keys, and the status query polls only while something is running. VERIFIED: `pnpm --filter @falcon/web test` — 136 test files / 1020 tests green (28 new in `features/run-panel/`); `pnpm --filter @falcon/web build` — Next static export succeeds and `/session/[id]/run` (and `/session/demo/run`) appear in the route table.

### Phase 6: Phase 6 — Docs, conventions, and full-pipeline verification

- [x] Update CLAUDE.md's package-layout blurbs: cli entry gains the setup/run-script subsystem (workspaceConfig fields, shellCommand/setupScript/runProcess/runStateStore/workspaceConfigRpc modules, the five new machine RPCs, the --setup-script/--run-script flags) and web gains features/run-panel/ + the /session/[id]/run route, matching the existing prose style.
- [x] Verify the security invariants hold by grep: no RPC params schema carries a script string (scripts only ever read from settings.json on the daemon side); every run/setup/getConfig handler calls the registry-backed context resolver; no 'preview:' wire literal was introduced (reserved.ts untouched). See "Security invariant checks" below for the actual grep output.
- [x] Run the full root pipeline in CI order: pnpm install → pnpm lint → pnpm --filter @falcon/wire build → pnpm typecheck → pnpm test; fix anything surfaced. See "Full-pipeline verification" below.
- [x] Document a manual smoke walkthrough at the bottom of docs/features/setup-run-scripts.md: falcon workspace register; falcon workspace config --setup-script 'npm install' --run-script 'npm run dev'; spawn with a new branch+worktree and confirm ~/.falcon/logs/setup-*.log appears and run-state.json records the setup outcome; exercise run.start/run.status/run.stop through the daemon test harness (the web live wiring remains behind the same not-yet-wired seam as every other feature area — state that explicitly rather than implying end-to-end web control works). See "Manual smoke walkthrough (actually run)" below.

**Acceptance:** All five root commands green in CI order (install, lint, wire build, typecheck, test); grep checks confirm no script-string-over-the-wire, authorizer coverage on all five handlers, and zero preview:* literals; CLAUDE.md updated; the feature doc's phase checklist fully checked with the manual smoke walkthrough recorded.

## Security invariant checks (grep, run for real)

```
$ grep -n 'idempotencyKey\|worktree' — WorkspaceGetConfigParamsSchema/RunStartParamsSchema/
  RunStopParamsSchema/RunStatusParamsSchema/RunSetupParamsSchema (packages/wire/src/rpc.ts):
  every one is exactly { idempotencyKey: z.string(), worktree: z.string() } — no script field.

$ grep -n "resolveRunContext" packages/cli/src/daemon/runProcess.ts packages/cli/src/daemon/workspaceConfigRpc.ts
  handleRunStart / handleRunStop / handleRunStatus / handleRunSetup / handleWorkspaceGetConfig
  all call it as their first line — all five handlers gated.

$ git diff --stat packages/wire/src/reserved.ts   →  (no output: file untouched)
$ grep -rn 'preview:' packages/wire/src/          →  only the two pre-existing doc-comment
  mentions (reserved.ts's own comment, and this feature's rpc.ts comment referencing it) —
  no new "preview:" string literal anywhere in code.
```

## Full-pipeline verification (run for real, in CI order)

- `pnpm install` — already satisfied (worktree created from an already-installed checkout;
  `pnpm install` re-run clean during this task with no changes needed).
- `pnpm lint` — the repo has **95 pre-existing lint errors** (mostly `noNonNullAssertion`/
  `useImportType`/`organizeImports`/formatting) spread across ~85 files this feature never
  touches (verified: none of this feature's new/modified files appear in the violation list,
  confirmed by diffing the flagged file paths against `git status --short`). All formatting/
  lint issues introduced by this feature's own new/modified files were found and fixed
  (`biome check --write` + a few manual fixes for `noConfusingVoidType`/`noNonNullAssertion`);
  `biome check <this feature's files>` is 0 errors. Fixing the pre-existing repo-wide debt is
  out of scope for this feature.
- `pnpm --filter @falcon/wire build` — green (`tsc --noEmit && pkgroll`).
- `pnpm typecheck` (root, all 11 packages) — green.
- `pnpm test` (root, via turbo, all packages concurrently) — `@falcon/wire` and `@falcon/web`
  fully green; `falcon` (cli) had 3 flaky failures (a DB-integration test hook timeout, and
  two unrelated pre-existing tests timing out at their default 5s) that reproduce ONLY under
  full-monorepo-concurrent load — re-running `pnpm --filter falcon test` standalone
  immediately after is 100% green (154/154 test files, 1795/1795 tests, confirmed twice).
  This is resource contention in the build sandbox (three packages' vitest workers +
  Next.js's build competing for CPU/memory), not a regression — none of the three failing
  tests are new or touched by this feature.

## Manual smoke walkthrough (actually run)

Run against a real (local-only, no remote) scratch git repo and a scratch `FALCON_HOME_DIR`,
using `packages/cli/bin/falcon.mjs` for the CLI commands and a direct `tsx` import of the
daemon modules for the RPC handlers (no live daemon/socket/web wiring exists yet — see
Phase 5's note):

1. `git init` a scratch repo, one commit.
2. `falcon workspace register --directory <repo>` → registered.
3. `falcon workspace config --directory <repo> --setup-script 'echo setup-ran > setup-marker.txt' --run-script 'sleep 30'` → prints back both scripts.
4. `ensureBranchWorkspace({repoDirectory: <repo>, branch: {name: 'wf/smoke-test', createWorktree: true}})` → `{directory: <repo>/.worktrees/wf/smoke-test, createdWorktree: true}`.
5. `runSetupScript({workspaceRoot: <repo>, directory: <worktree>}, {homeDir})` → `{started: true}`; after a short wait, `setup-marker.txt` exists in the worktree with contents `setup-ran`, and `~/.falcon/run-state.json` (well, the scratch homeDir's copy) records `{setup: {state: "succeeded", exitCode: 0, ...}}` with a real `logFile` under `<homeDir>/logs/setup-<hash>.log`.
6. `handleRunStart({idempotencyKey, worktree: <worktree>}, {homeDir})` → `{started: true, method: "tmux", pid: <real pid>, tmuxSessionName: "falcon-run-<hash>"}` — a real `tmux new-session` ran.
7. `handleRunStatus(...)` → `{run: {state: "running", pid, method: "tmux", startedAt, logTail: ""}, setup: {state: "succeeded", ...}}`.
8. `handleWorkspaceGetConfig(...)` → `{setupScript: "echo setup-ran > setup-marker.txt", runScript: "sleep 30"}` (config surfaced read-only, never written back).
9. `handleRunStop(...)` → `{stopped: true, wasRunning: true}` — confirmed via `tmux ls` that the `falcon-run-<hash>` session was actually gone afterward (real kill, not just a state-file update).
10. `handleRunStatus(...)` again → `{run: {state: "none"}, setup: {state: "succeeded", ...}}` (setup outcome persists past the run stopping, as designed).

All ten steps passed exactly as designed on a real filesystem/tmux/process. Scratch repo,
homeDir, and script all deleted afterward — no leftover tmux sessions, no leftover files
outside the scratchpad.

**What this does NOT cover** (documented explicitly, not silently skipped): the web run panel
is not clickable end-to-end from a browser — `RunPanel`'s live wiring
(`use-live-run-panel-actions.ts`) is real and unit-tested, but (same as every other feature
area in this codebase per CLAUDE.md's own running note) no screen threads a live `apiSocket`
connection + per-machine crypto client through yet, so exercising it requires either that
separate sync-engine wiring task or a browser session against a live daemon + server, neither
of which exists in this sandbox. The five machine RPCs themselves are exercised directly
above (bypassing the WS transport, which is already covered by `machineRpc.test.ts`'s
seal/unseal round-trip tests) — that is the honest boundary of what was verified here.


## Status

**Implementation complete, all six phases done and verified.** All 46 phase checklist items
checked off — every one actually completed (real code, real tests, real manual smoke run; see
above for exactly what was and wasn't exercised).

- Phase 1 (wire schemas + config store + CLI flags): done. `pnpm --filter @falcon/wire test`
  green (153 tests, additive-only suite covers all 10 new schemas).
- Phase 2 (createdWorktree signal + setup-script runner): done. New tests in
  `gitWorktree.test.ts`, `shellCommand.test.ts`, `runStateStore.test.ts`, `setupScript.test.ts`,
  `spawnEngine.test.ts` all green.
- Phase 3 (daemon run-process subsystem): done. `runProcess.test.ts` (23 tests) +
  `workspaceConfigRpc.test.ts` (4 tests) green, covering the full lifecycle, auth-gate
  rejection, stale-pid recovery, and daemon-restart persistence.
- Phase 4 (machine-RPC registration + wiring): done. `machineRpc.test.ts` (81 tests,
  including the five new methods' registration/dispatch/idempotency/concurrent-join tests)
  and the web `sync/machineRpc.ts` client tests (22 tests) all green.
- Phase 5 (web run panel + route): done. `packages/web/src/features/run-panel/` (types,
  mock-source, live-actions, use-live-run-panel-actions, use-run-panel, RunPanel/RunPanelBody,
  SessionRunScreen) + the `/session/[id]/run` route + a "Setup / Run" header link, 28 new
  tests green, `next build` succeeds with the new route in the output table.
- Phase 6 (docs + full-pipeline verification + manual smoke test): done — see the two
  sections above for the actual commands/output.

**Known gaps, stated explicitly (not silently skipped):**
- The web run panel's live wiring exists and is unit-tested but isn't reachable from a real
  browser session yet — no screen anywhere in this codebase threads a live `apiSocket` +
  per-machine crypto client through (a separate, cross-cutting sync-engine wiring task every
  other feature area in CLAUDE.md's package-layout notes shares the same gap).
- `pnpm test` at the repo root (all packages concurrently via turbo) is flaky in this sandbox
  under full concurrent load (3 unrelated pre-existing tests time out); every package's test
  suite is 100% green when run standalone (`pnpm --filter <pkg> test`), confirmed multiple
  times. Not a regression — see "Full-pipeline verification" above.
- Windows support of `shellCommand.ts`'s `cmd.exe /c` path is implemented and unit-tested with
  an injectable `platform`, but was never exercised on a real Windows machine (no Windows CI
  in this repo) — the same caveat the original plan's risk list already flagged.

## Test & Review notes (independent verification pass)

Reviewed as an independent tester in `.worktrees/feature-setup-run-scripts` — did not trust the
checked boxes, re-derived each acceptance criterion from real commands/code reading.

**Full pipeline, run for real:**
- `pnpm install` — clean.
- `pnpm build` — green (6/6 tasks, `@falcon/web`'s route table includes `/session/[id]/run`
  and `/session/demo/run`).
- `pnpm typecheck` — green (11/11 packages).
- `pnpm test` (root, turbo, all packages concurrently) — reproduced the exact same 3 flaky
  failures the implementer documented (`index.test.ts`'s `--help`/`--version` tests timing out
  at 5s, and `scanner.test.ts`'s hook-gating test) — confirmed these are pre-existing/unrelated
  to this feature by checking `git show dfc44bd -- packages/cli/src/index.test.ts`: this
  feature's commit only *added* workspace-config subcommand tests to that file, never touched
  the `--help`/`--version` tests that failed. Re-ran `pnpm --filter falcon test` standalone
  immediately after: **154/154 test files, 1795/1795 tests green**, confirming resource
  contention under full-monorepo-concurrent load, not a regression. `pnpm --filter @falcon/wire
  test` (153/153) and `pnpm --filter @falcon/web test` (136/136 files, 1020/1020 tests) both
  green standalone too.

**Real, from-scratch manual smoke test** (independent of the implementer's own walkthrough —
fresh scratch git repo + scratch `FALCON_HOME_DIR`, real tmux, using the built
`packages/cli/bin/falcon.mjs` for CLI commands and a direct `tsx` import for the daemon RPC
handlers): `workspace register` → `workspace config --setup-script --run-script` → verified
`--setup-script ""` actually clears the field (re-read shows `(none)`) →
`ensureBranchWorkspace` with a new branch → `createdWorktree: true` → `runSetupScript` →
confirmed `setup-marker.txt` really exists in the worktree with the right contents →
`handleRunStart` → real `tmux new-session` (`falcon-run-<hash>`) → `handleRunStatus` reports
`running` with the real pid/method → `handleWorkspaceGetConfig` reads back both scripts →
`handleRunStop` → confirmed via `tmux ls` that the tmux server itself had nothing left running
(the session was really killed, not just marked stopped in the state file) → `handleRunStatus`
again reports `run: {state: "none"}` while `setup` stays `succeeded`. All 10 steps passed
exactly as designed. Scratch repo/homeDir/tmux session all cleaned up afterward.

**Code-level verification (not just trusting tests):**
- `resolveRunContext` is confirmed as the first line of all five handlers
  (`handleRunStart`/`handleRunStop`/`handleRunStatus`/`handleRunSetup`/
  `handleWorkspaceGetConfig`) via direct grep — the design §12 auth gate is real, not just
  claimed.
- `reserved.ts` is untouched (`git diff` against the target branch shows no output) and no new
  `preview:` string literal exists anywhere in `packages/wire/src/` beyond the two pre-existing
  doc-comment mentions.
- The wire additive-only fixture (`__fixtures__/wire-shapes.json`) has real, detailed frozen
  shapes for all 10 new schemas (not placeholder/empty entries) — spot-checked
  `RunStatusResultSchema`'s nested `run`/`setup` enum shapes match `rpc.ts` exactly.
- `withResourceGuard`'s worktree-keyed concurrent-join for `run.start` and
  `withIdempotencyCache`'s replay-on-retry are both exercised by real tests
  (`machineRpc.test.ts`) that actually assert the underlying handler is called exactly once
  across two racing calls with different idempotency keys — read the test bodies, not just the
  pass/fail count.
- `runStateStore.ts`'s durability pattern (tmp-write+rename, per-homeDir write-queue,
  tolerant corrupt-file reader) is a faithful structural match to `sessionsStore.ts`'s
  established precedent.
- Spotted one minor documentation-accuracy nit (not a bug): the plan's Phase 1 checklist text
  describes `WorkspaceGetConfigParamsSchema`/`RunStatusParamsSchema` as just `{worktree}`, but
  the actual shipped schemas add `idempotencyKey` to both (matching every other RPC in this
  codebase, including the read-only `git.status`, which also carries `idempotencyKey` despite
  never being idempotency-cached) — a sensible consistency choice the implementer made without
  calling it out as a deviation. No functional impact; noting it here for the record.

**Verdict: no functional bugs found.** Every phase's acceptance criteria actually holds under
direct, independent re-verification — not just a re-read of the checked boxes. No fixes were
necessary in this pass.
