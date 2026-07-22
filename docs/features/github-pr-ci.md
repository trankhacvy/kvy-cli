# GitHub PR/CI integration (docs/competitive-notes-omnara.md #4)

**Slug:** `github-pr-ci` · **Branch:** `wf/feature-github-pr-ci` · **Target:** `v2-pty-injection`

## Feature description

GitHub PR/CI integration. A "Checks" tab in the sidebar shows real CI check results once you push and open a PR ("Open a pull request to see CI checks — Commit and push your changes, then create a PR"), backed by a GitHub OAuth connection surfaced in Settings → Git ("GitHub is not connected — Login to GitHub to resolve pull requests and CI checks").

## Solution (Opus 4.8)

Build "GitHub PR/CI checks" the same way the existing Git panel is built: a read-only, on-demand **machine RPC** answered by the daemon over the existing E2E-encrypted machine-RPC channel, surfaced in the web as a new feature area + a "Checks" tab. Do NOT build it as a server-side GitHub OAuth/webhook integration despite Omnara's "Settings → Git · Login to GitHub" framing — that path fights Falcon's core "server holds no keys, stores only ciphertext" principle. The daemon already runs local git (gitExec.ts), already knows the workspace's remote (workspaceConfig.ts `--remote`), and already returns git.status/git.diff/git.branches over the encrypted channel; PR/CI checks are the natural next member of that RPC family.

CONCRETE FLOW:
1. Web opens the Checks tab → fires a `github.checks` machine RPC (idempotencyKey + worktree, structural clone of GitStatusParams), gated on the per-machine DEK unwrap exactly like useLiveGitDiffActions.
2. Daemon handler (new daemon/githubChecks.ts) resolves the remote URL → owner/repo (`git remote get-url`), resolves the current branch (`git rev-parse --abbrev-ref HEAD`), finds the open PR for that branch head, and fetches its check-runs/statuses. Returns `{ connected, pr: {number,title,url,state}|null, checks: CheckRun[] }`.
3. If no GitHub auth is present → `{connected:false}` drives the Settings "GitHub is not connected — Login to GitHub" CTA. If connected but no PR for the branch → `{connected:true, pr:null, checks:[]}` drives the "Open a pull request to see CI checks — commit and push, then create a PR" empty state. Both empty states are DERIVED from the RPC result, never stored (design principle #3, same as deriveSessionStatus).
4. Web renders checks in a new features/github-checks/ area (mirror of features/git-diff/), refreshed via react-query with a refetchInterval since machine RPCs have no push channel (the use-git-panel.ts "point-in-time RPC snapshot" note applies).

GITHUB AUTH (daemon-local, the key decision): the GitHub token is a machine-local secret stored under ~/.falcon/ (0600 file / settings.json, same pattern as access.key and claudeAuth.ts), NOT on the server. Obtain it via the GitHub OAuth **device authorization flow** initiated by the daemon/CLI (`falcon github login`), reusing the server's existing GITHUB_OAUTH_CLIENT_ID but with elevated `repo`/`read:checks` scope — this is a SEPARATE authorization from the account-recovery OAuth binding, which uses no scopes. The daemon then calls GitHub's REST API directly with fetch (same shape as auth/oauth.ts's verifyGithubAccessToken/exchangeGithubCode). Alternative to flag: shell out to the user's existing `gh` CLI (`gh pr checks`, `gh api`) — zero new OAuth, but depends on an external tool being installed and authenticated.

REUSES THESE EXISTING PATTERNS (do not invent parallels):
- Machine-RPC family: add `"github.checks"` (and optionally `"github.status"` for connection state) to MACHINE_RPC_METHODS in cli/src/daemon/machineRpc.ts and to the web caller in web/src/sync/machineRpc.ts. No idempotency cache needed — read-only, same justification the module already gives for git.status/git.diff/git.branches. All the decrypt/validate/seal plumbing is generic and untouched.
- Wire schema: GitStatusParams (idempotencyKey+worktree) is the template for GithubChecksParams. Add CheckRunSchema (name, status enum queued|in_progress|completed, conclusion enum success|failure|neutral|cancelled|..., detailsUrl, startedAt/completedAt) and PullRequestInfoSchema + GithubChecksResultSchema to wire/src/rpc.ts. Wire payloads are additive-only forever (schema.ts bytea comment) — this is purely additive.
- Daemon git access: gitExec.ts's runGit is the injectable execFile wrapper for `git remote get-url`/`git rev-parse`. New githubChecks.ts mirrors gitStatus.ts's deps-injection + parse shape. Remote→owner/repo parsing must handle both SSH (git@github.com:owner/repo.git) and HTTPS remote URLs; non-github remotes → connected:false or an explicit "not a github remote" signal.
- Local credential storage: ~/.falcon/ 0600 files (access.key) and claudeAuth.ts are the precedent for a machine-local github token store (new daemon/githubAuth.ts). workspaceConfig.ts (settings.json workspaces map) already stores per-workspace `remote` and is the precedent if the token is scoped per-workspace vs global.
- Web feature area: features/git-diff/ is the exact template — types.ts (GithubChecksActions), mock-source.ts, live-actions.ts + use-live-github-checks-actions.ts (gated on useMachineCrypto), use-checks-panel.ts (react-query), components/ (ChecksList, CheckRunRow, ChecksEmptyState, SessionChecksScreen). Route at app/(protected)/session/[id]/checks/page.tsx mirroring .../[id]/git/page.tsx.
- UI shell ALREADY EXISTS: SessionSidePanel.tsx already has a "checks" PanelTab and a ChecksTab() placeholder ("Placeholder checks — CI wiring isn't connected to this panel yet") — this is the mount point; replace the dummy data with the live RPC. SessionTimelineScreen.tsx's "Files changed" Link (line 209) is the template for a "Checks" link.
- Settings → Git page (app/(protected)/settings/git/page.tsx) is currently a thin localStorage-only client component. The GitHub connection section ("GitHub is not connected — Login to GitHub…") gets added here — BUT the connection is per-machine (token lives on a daemon), so this section either needs a machine selector or the connect action must be surfaced per-session/per-machine instead of as a single account-level toggle. This is the biggest UI-model tension (see risks).

SERVER-SIDE (Option B, recommended AGAINST but documented for the planning pass): would need a github_connections table, a POST /v1/github/exchange route with elevated scopes, a POST /v1/github/webhook receiver for real-time check updates, and eventRouter fan-out. Advantages: works when the machine/daemon is offline, real-time via webhooks. Cost: server holds a live GitHub token and plaintext CI data (PR titles, check names) — a direct violation of the E2E "server decrypts nothing" invariant. Only reconsider if offline-machine support is a hard requirement.

## Plan (Fable 5)

Build GitHub PR/CI checks as the next member of the existing read-only git machine-RPC family: a new `github.checks` RPC (params `{idempotencyKey, worktree}`, structural clone of `git.status`) answered by the daemon, which resolves the workspace's remote → owner/repo, the current branch, the open PR for that branch head, and the PR head commit's check-runs via the GitHub REST API — authenticated with a machine-local token stored 0600 under `~/.falcon/` (mirroring `auth/credentials.ts`), obtained via `falcon github login` (GitHub device flow with a CLI-side client id, or `--token` PAT paste). The web gets a `features/github-checks/` area (exact structural clone of `features/git-diff/`), a `/session/[id]/checks/` route, react-query polling (60s, foreground-only), and derived empty states for no-token / unsupported-remote / not-pushed / no-PR / ok — plus wiring the existing `SessionSidePanel` "Checks" placeholder tab to the same panel. Zero server changes; the server never sees the token or any CI data (design §5.3/§6.1 preserved). Five phases: wire schemas → CLI auth (token store + login command) → daemon RPC handler → web feature area + route → surfaces/docs/final verification.

**Risks:** Token custody: a repo-scoped GitHub token is a high-value secret on the user's machine. Mitigations are load-bearing tasks, not suggestions: 0600 tmp-write+rename file (credentials.ts pattern), token never in argv, never in logger calls, never in RPC results — Phase 2/3 tests assert all three. It is still one `cat ~/.falcon/github.key` away for local malware, same exposure class as access.key and gh's own token.; Device-flow client id: no Falcon GitHub OAuth app with Device Flow enabled exists yet, and the server's GITHUB_OAUTH_CLIENT_ID is unreachable from the CLI. Until someone creates/enables that app and bakes its client id into DEFAULT_GITHUB_CLIENT_ID, `falcon github login` only works via `--token` (PAT) or FALCON_GITHUB_CLIENT_ID — the plan ships PAT-first-class so the feature is not blocked on an ops task.; GitHub rate limits (5000/hr/token): 60s foreground-only polling of 2 API calls per open Checks view is ~120 req/hr per open tab — fine for one tab, but many simultaneously-open sessions multiply it. ETag conditional requests are deliberately deferred; if this bites, they slot into githubChecks.ts without wire changes.; Offline machine: checks are unavailable when the daemon is offline — a real functional gap vs Omnara's server-side webhook model, accepted deliberately because every sibling machine RPC (git.status/git.diff) shares it and the alternative breaks the server-holds-no-plaintext invariant.; Fork workflows and multi-remote repos: the PR lookup assumes head owner == repo owner (`head={owner}:{branch}`), so PRs from a fork's branch won't resolve; workspaceConfig's `remote` (default origin) picks the repo. Documented in-code as an MVP limitation; wrong-but-honest empty state (no-pr) rather than wrong data.; Older-daemon degrade depends on matching machineRpc.ts's unknown-method error string in web live-actions; if that string ever changes, the UI falls back to a generic error instead of 'update falcon' — brittle but contained, and covered by a test on the current string.; SessionSidePanel is otherwise still fully placeholder (dummy branch header, disabled Commit & Push); wiring only its Checks tab creates a half-live panel — acceptable, but the implementer must not be tempted to 'fix' the rest of the panel in this feature's scope.; GitHub API shape drift (check_runs pagination beyond 100, merged-state detection via merged_at): per_page=100 without pagination is an accepted MVP cap; PRs with >100 check runs will silently truncate.
**Files likely touched:** packages/wire/src/rpc.ts, packages/wire/src/__tests__/schemaRegistry.ts, packages/wire/src/__tests__/__fixtures__/wire-shapes.json, packages/cli/src/github/githubAuth.ts, packages/cli/src/github/githubAuth.test.ts, packages/cli/src/github/deviceFlow.ts, packages/cli/src/github/deviceFlow.test.ts, packages/cli/src/commands/github.ts, packages/cli/src/commands/github.test.ts, packages/cli/src/args.ts, packages/cli/src/index.ts, packages/cli/src/daemon/githubChecks.ts, packages/cli/src/daemon/githubChecks.test.ts, packages/cli/src/daemon/machineRpc.ts, packages/cli/src/daemon/machineRpc.test.ts, packages/web/src/sync/machineRpc.ts, packages/web/src/features/github-checks/types.ts, packages/web/src/features/github-checks/mock-source.ts, packages/web/src/features/github-checks/live-actions.ts, packages/web/src/features/github-checks/use-live-github-checks-actions.ts, packages/web/src/features/github-checks/use-checks-panel.ts, packages/web/src/features/github-checks/components/ChecksPanel.tsx, packages/web/src/features/github-checks/components/CheckRunRow.tsx, packages/web/src/features/github-checks/components/SessionChecksScreen.tsx, packages/web/src/features/github-checks/index.ts, packages/web/src/app/(protected)/session/[id]/checks/page.tsx, packages/web/src/components/timeline/SessionSidePanel.tsx, packages/web/src/components/timeline/SessionTimelineScreen.tsx, packages/web/src/app/(protected)/settings/git/page.tsx, falcon-system-design.md, plan.md, CLAUDE.md, docs/features/github-pr-ci.md

## Phases

### Phase 1: Phase 1 — Wire contract: github.checks schemas in @falcon/wire

- [x] In packages/wire/src/rpc.ts, directly after the GitBranches block (~line 179), add `GithubChecksParamsSchema = z.object({ idempotencyKey: z.string(), worktree: z.string() })` — an exact structural clone of GitStatusParamsSchema/GitBranchesParamsSchema — with a doc comment citing design §4.4 and docs/features/github-pr-ci.md. Export `type GithubChecksParams`.
- [x] Add `CheckRunSchema = z.object({ name: z.string(), status: z.enum(["queued","in_progress","completed"]), conclusion: z.enum(["success","failure","neutral","cancelled","skipped","timed_out","action_required","stale"]).optional(), detailsUrl: z.string().optional(), startedAt: z.number().optional(), completedAt: z.number().optional() })` — timestamps are unix seconds, matching GitBranchInfoSchema's `lastCommitAt` precedent. Export `type CheckRun`.
- [x] Add `PullRequestInfoSchema = z.object({ number: z.number(), title: z.string(), url: z.string(), state: z.enum(["open","closed","merged"]), headSha: z.string(), draft: z.boolean().optional() })`. Export `type PullRequestInfo`.
- [x] Add `GithubChecksResultSchema = z.object({ state: z.enum(["no-token","unsupported-remote","not-pushed","no-pr","ok"]), repo: z.object({ owner: z.string(), name: z.string() }).optional(), branch: z.string().optional(), pr: PullRequestInfoSchema.optional(), checks: z.array(CheckRunSchema).optional(), message: z.string().optional() })`. Doc-comment each `state` value: no-token → 'GitHub is not connected on this machine' CTA; unsupported-remote → non-github.com remote (or detached HEAD, carried in `message`); not-pushed → branch absent from the remote ('commit and push, then create a PR' copy); no-pr → pushed but no open PR; ok → `pr` + `checks` populated from the PR head SHA. Export `type GithubChecksResult`.
- [x] Export all four schemas + types from the package barrel the same way GitBranches* are exported (check packages/wire/src/index.ts / how rpc.ts is re-exported and mirror it exactly).
- [x] Register the four new schemas in packages/wire/src/__tests__/schemaRegistry.ts (alongside GitBranchesParamsSchema/GitBranchesResultSchema at ~line 33) and add their frozen shapes to packages/wire/src/__tests__/__fixtures__/wire-shapes.json, following whatever regeneration procedure additiveOnly.test.ts documents — additive-only, no existing shape edited.

**Acceptance:** `pnpm --filter @falcon/wire build && pnpm --filter @falcon/wire test` passes, including additiveOnly.test.ts with the four new fixture entries; `GithubChecksParams`, `GithubChecksResult`, `CheckRun`, `PullRequestInfo` are importable from `@falcon/wire` (verify via the typecheck task).

### Phase 2: Phase 2 — CLI GitHub auth: machine-local token store + `falcon github login|logout|status`

- [x] Create packages/cli/src/github/githubAuth.ts — port of packages/cli/src/auth/credentials.ts's exact pattern: zod-validated JSON `{ token: string, createdAt: number, scope?: string, method: "device-flow" | "pat" }` at `~/.falcon/github.key`, written with mode 0o600 (same sync writeFileSync+chmodSync shape as `auth/credentials.ts`'s own precedent — see that module's own doc comment for why this isn't the separate async tmp-write+rename `persistence.ts` path), `readGithubToken(homeDir?)` never throws (returns null on missing/corrupt), `writeGithubToken(...)`, `clearGithubToken(...)`, injectable homeDir via resolveHomeDir default. The token value must never be passed to the logger.
- [x] Create packages/cli/src/github/deviceFlow.ts: `requestDeviceCode({clientId, fetchImpl})` → POST https://github.com/login/device/code (Accept: application/json, body client_id + scope="repo") returning {deviceCode, userCode, verificationUri, interval, expiresIn}; `pollForToken({clientId, deviceCode, interval, fetchImpl, sleep})` → POST https://github.com/login/oauth/access_token with grant_type=urn:ietf:params:oauth:grant-type:device_code, looping on `authorization_pending`, honoring `slow_down` (+5s), failing cleanly on `expired_token`/`access_denied`. Both take injectable `fetchImpl` (default global fetch) and `sleep` for tests.
- [x] Create packages/cli/src/commands/github.ts implementing: `falcon github login [--token] [--client-id <id>]` — with `--token`, prompt for a PAT on stdin (never accept the token as an argv value); otherwise run the device flow, printing the user code + verification URI, with client id resolved `--client-id` flag → `FALCON_GITHUB_CLIENT_ID` env → a `DEFAULT_GITHUB_CLIENT_ID` constant (empty string until a Falcon OAuth app exists — when empty and no override, print an instruction to use `--token` or set the env var and exit non-zero); on success write via githubAuth.ts and print the granted scope. `falcon github logout` — clearGithubToken. `falcon github status` — token present? then GET https://api.github.com/user (Authorization: Bearer, X-GitHub-Api-Version: 2022-11-28) and report login + scopes (from the X-OAuth-Scopes response header) or 'invalid token'.
- [x] Wire the command into packages/cli/src/args.ts (new `github` command type with `login|logout|status` actions + `--token`/`--client-id` flags, following parseWorkspaceConfig's flag-parsing shape at ~line 235-257) and packages/cli/src/index.ts dispatch, following exactly how `workspace`/`adapters` commands are registered. No daemon interaction — this is a local file + HTTPS operation, same precedent as `falcon workspace config`.
- [x] Tests: packages/cli/src/github/githubAuth.test.ts (round-trip, 0600 mode assertion via fs.stat, corrupt-file → null, clear), deviceFlow.test.ts (pending→success sequence, slow_down backoff, expired/denied errors — all with fake fetch/sleep), commands/github.test.ts (arg parsing incl. rejection of a token passed as a bare argv value, client-id resolution order, status output shapes with fake fetch). Mirror the structure of commands/workspaceRegister.test.ts.

**Acceptance:** `pnpm --filter falcon test` passes with the new github/ and commands/github tests; manual smoke: `falcon github login --token` (pasting a PAT) creates `~/.falcon/github.key` with mode 0600, `falcon github status` prints the GitHub login, `falcon github logout` removes it; grep confirms the token string is never interpolated into any logger call.

### Phase 3: Phase 3 — Daemon: github.checks RPC handler + registration

- [x] Create packages/cli/src/daemon/githubChecks.ts modeled on gitStatus.ts's deps-injection shape. Export `parseGithubRemote(url: string): { owner: string; name: string } | null` handling `git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo.git`, `https://github.com/owner/repo` and `.git`-suffixed variants; any non-github.com host (including GitHub Enterprise) returns null for MVP.
- [x] Export `getGithubChecks(params: GithubChecksParams, deps): Promise<GithubChecksResult>` with `deps = { git?: GitExec (default gitExec.ts runGit), fetchImpl?: typeof fetch, readToken?: () => GithubToken | null (default githubAuth.ts readGithubToken — read fresh per call so a login while the daemon runs takes effect without restart), getWorkspaceRemote?: (dir: string) => string | undefined (default: read workspaceConfig.ts's per-workspace `remote`, same precedent as git.diff's baseRef fallback) }`. Flow: (1) no token → {state:"no-token"}; (2) remoteName = configured remote ?? "origin"; `git remote get-url <remoteName>` in params.worktree — failure or parseGithubRemote null → {state:"unsupported-remote", message}; (3) `git rev-parse --abbrev-ref HEAD` — literal "HEAD" (detached) → {state:"unsupported-remote", message:"detached HEAD"}; (4) GET https://api.github.com/repos/{owner}/{name}/pulls?head={owner}:{branch}&state=open (headers: Authorization Bearer, Accept application/vnd.github+json, X-GitHub-Api-Version 2022-11-28) — note in a comment that fork-workflow PRs (head owner ≠ base owner) are out of scope for MVP; (5) empty → `git ls-remote --heads <remoteName> <branch>`: empty output → {state:"not-pushed", branch} else {state:"no-pr", branch, repo}; (6) PR found → map first result to PullRequestInfo (merged detection via merged_at when state=closed), then GET /repos/{owner}/{name}/commits/{pr.head.sha}/check-runs?per_page=100 → map check_runs[] to CheckRun[] (started_at/completed_at ISO → unix seconds), return {state:"ok", repo, branch, pr, checks}; (7) HTTP 401 → {state:"no-token", message:"stored token was rejected"}; other non-2xx (incl. 403 rate-limit) → throw, letting machineRpc's uniform sealed error path answer — never fabricate an empty success.
- [x] Register the RPC in packages/cli/src/daemon/machineRpc.ts: add "github.checks" to MACHINE_RPC_METHODS (~line 140), add optional dep `getGithubChecks?: (params: GithubChecksParams) => Promise<GithubChecksResult>` defaulting to the real handler (identical convention to `getGitStatus?` at line 162), add the MethodSpec entry with GithubChecksParamsSchema/GithubChecksResultSchema, and extend the module's header comment's no-idempotency-cache justification list (read-only, same reasoning as git.status/git.diff/git.branches). Confirm machineIntegration.ts needs no change (the dep defaults inside machineRpc.ts like getGitStatus does — only gitDiff needed explicit wiring, for blob upload).
- [x] Tests: daemon/githubChecks.test.ts covering parseGithubRemote (all 4 accepted forms + enterprise-host + non-github rejections), every state branch with fake git/fetch/readToken (no-token, unsupported-remote, detached HEAD, not-pushed vs no-pr via ls-remote, ok with check-run field mapping incl. ISO→unix conversion, 401→no-token, 500→throw), and confirming the token appears in the Authorization header but never in the returned result object. Extend daemon/machineRpc.test.ts with a github.checks sealed round-trip case mirroring the existing git.status case, plus the unknown-method behavior already covered there stays green.

**Acceptance:** `pnpm --filter falcon build && pnpm --filter falcon test` green including the new githubChecks.test.ts state-matrix and the machineRpc.test.ts github.checks round-trip; `rg 'github.key|token' packages/cli/src/daemon/githubChecks.ts` shows no logger call receiving the token.

### Phase 4: Phase 4 — Web: sync caller, features/github-checks area, /session/[id]/checks route

- [x] packages/web/src/sync/machineRpc.ts: import `GithubChecksParams`/`GithubChecksResultSchema` from @falcon/wire and add "github.checks" to the MachineRpcParams map, MachineRpcResults map, and the result-schema table (~line 103), exactly parallel to the git.status entries.
- [x] Create packages/web/src/features/github-checks/ as a structural clone of features/git-diff/: types.ts — `GithubChecksActions { fetchChecks(worktree: string): Promise<GithubChecksResult> }` + `UseGithubChecksActions = (machineId: string) => GithubChecksActions`; mock-source.ts — `useMockGithubChecksActions` returning fixtures for every state (ok with mixed queued/in_progress/completed×conclusion runs, no-pr, not-pushed, no-token, unsupported-remote) selectable for tests; live-actions.ts — `machineRpcToGithubChecksActions(client)` minting the idempotencyKey (via `crypto.randomUUID()`, matching git-diff's own live-actions.ts precedent verbatim rather than the plan's cuid2 phrasing), and mapping the sealed `{ok:false, error}` unknown-method rejection (matches `MachineRpcError`'s message against machineRpc.ts's `"unknown-method"` error string) to a typed `DaemonUnsupportedError` so the UI can distinguish 'update falcon' from a real failure; use-live-github-checks-actions.ts — verbatim structural copy of use-live-git-diff-actions.ts (useMachineCrypto gate, pendingGithubChecksActions rejecting with the same NOT_READY_MESSAGE pattern); use-checks-panel.ts — `useQuery({ queryKey: ["github-checks", worktree], queryFn, refetchInterval: 60_000, refetchIntervalInBackground: false })` plus an exposed manual `refetch`, with a comment citing the GitHub 5000/hr rate budget as the reason for the 60s floor and foreground-only polling.
- [x] components/: `CheckRunRow` (icon per status/conclusion — success/failure/neutral/in-progress spinner/queued clock, name, relative duration from startedAt/completedAt, detailsUrl as an external link), `ChecksPanel({ machineId, worktree, useActions? })` composing the query hook + rendering by state (delegated to an extracted, directly-testable `ChecksBody` — mirrors `SessionTimelineScreen.tsx`'s own `LifecycleBanner` extraction) — state "no-pr": the Omnara-derived copy 'Open a pull request to see CI checks — Commit and push your changes, then create a PR' (adjusted since no-pr means already pushed: 'No open pull request for <branch> — create a PR to see CI checks'); "not-pushed": 'Commit and push your changes, then create a PR'; "no-token": 'GitHub is not connected on this machine — run `falcon github login` in a terminal on it'; "unsupported-remote": the result's message; DaemonUnsupportedError: 'This machine's falcon daemon doesn't support CI checks yet — update falcon and restart the daemon'; plus a PR header row (number, title, url, state badge) when state=ok; `SessionChecksScreen({ sessionId })` — verbatim structural copy of SessionGitScreen.tsx: useSyncSnapshotQuery → session.machineId/session.workspaceId guard → ChecksPanel. index.ts barrel exporting the screen + panel + types, matching git-diff/index.ts.
- [x] Create packages/web/src/app/(protected)/session/[id]/checks/page.tsx — byte-for-byte pattern copy of ../git/page.tsx (generateStaticParams returning [{id:"demo"}], async params await, render SessionChecksScreen) with the comment updated.
- [x] packages/web/src/components/timeline/SessionTimelineScreen.tsx (~line 209): add a 'Checks' Link to `/session/${sessionId}/checks/` beside the existing 'Files changed' link, same styling.
- [x] Tests mirroring git-diff's suite: mock-source.test.ts (fixture states validate against GithubChecksResultSchema), live-actions.test.ts (idempotencyKey minted per call, unknown-method → DaemonUnsupportedError, result passthrough), a ChecksPanel render test driving every state via the mock source (assert each empty-state copy string renders — via the extracted `ChecksBody`, since this package has neither jsdom nor `@testing-library/react` wired up, same constraint every other render test in this codebase already works within), and a use-live-github-checks-actions.test.ts copy of use-live-git-diff-actions.test.ts (pending until crypto resolves).

**Acceptance:** `pnpm --filter @falcon/web build && pnpm --filter @falcon/web test` green; the ChecksPanel render test proves all six UI states (5 wire states + daemon-unsupported) produce their distinct copy; `next build` static export emits the /session/[id]/checks route without errors.

### Phase 5: Phase 5 — Side-panel + Settings surfaces, docs, end-to-end verification

- [x] packages/web/src/components/timeline/SessionSidePanel.tsx: extend the props to `{ defaultTab?, machineId?: string, worktree?: string }`; when both machineId and worktree are provided, ChecksTab renders the real `<ChecksPanel machineId worktree />` from features/github-checks (delete the two hardcoded dummy check cards for that branch of the conditional); when absent, keep the current placeholder including its 'Placeholder checks' caption. Update the component doc comment — the Checks tab is no longer placeholder when props are threaded.
- [x] packages/web/src/components/timeline/SessionTimelineScreen.tsx (~line 280): thread `machineId={session?.machineId} worktree={session?.workspaceId}` into `<SessionSidePanel />` (both values already resolved in scope — verified at lines 85-89).
- [x] packages/web/src/app/(protected)/settings/git/page.tsx: add a 'GitHub' section below the branch-mode buttons — an informational card: heading 'GitHub', body 'GitHub is not connected through this app. CI checks connect per machine: run `falcon github login` in a terminal on the machine that hosts your sessions, then open a session's Checks tab.' Include a code-styled `falcon github login` snippet. Explicitly NO live toggle/machine selector — add a code comment explaining the per-machine token model and why an account-level toggle would require the server to see the token (design §5.3).
- [x] Docs: falcon-system-design.md §4.4 — add `'github.checks'({worktree}) → { state, pr?, checks? }` to the machine-RPC table with a one-line description + the machine-local-token note; plan.md §16 — add the feature under its phase list as landed-by-this-branch work (added as a Phase 4.1 "Git panel" follow-on bullet — the actual v1 phase §16 hasn't been touched by any of the sibling v2 features either, e.g. `git.branches`/worktree-isolation, but the bullet's own instruction is followed here rather than silently skipped); CLAUDE.md — extend the cli and web package blurbs (github auth command + daemon/githubChecks.ts; features/github-checks + checks route), matching the existing prose style; docs/features/github-pr-ci.md is this plan itself — the implementer checks phases off there.
- [x] Full-repo verification: `pnpm build && pnpm typecheck && pnpm test && pnpm lint` from the root. `build`/`typecheck`/`test` all green (6/6, 11/11, 11/11 turbo tasks respectively — 1618 `falcon` cli tests, 818 `@falcon/web` tests, 316 `@falcon/server` tests, 111 `@falcon/wire` tests). `pnpm lint` itself is not usable as written in this sandbox: this environment's `rtk` Bash-hook (documented elsewhere in this repo, e.g. plan.md's Phase 0/1 land-task narratives, as capable of fabricating `git`/`pnpm` output) intercepts every `pnpm`/`biome` invocation and unconditionally reports `[warn] Linter process terminated abnormally (possibly out of memory)` regardless of the real command (reproduced even for a bare `biome --version`) — not the transient-OOM case this file's own "Commands" section describes. Bypassing it via the documented `rtk proxy <cmd>` escape hatch gets real `biome check` output: repo-wide, 109 pre-existing errors / 134 warnings across files this feature never touched (confirmed one representative case — `packages/wire/src/__tests__/__fixtures__/wire-shapes.json`'s own committed `HEAD` revision, checked via `git show`, already fails `biome format` before this feature's changes — the snapshot-shapes.ts-generated fixture's JSON array-wrapping style has never matched biome's own formatter). Every file this feature actually added or touched (22 files, listed above) was checked in isolation via the same `rtk proxy` bypass and is 100% clean — 0 errors, 0 warnings — after one `biome check --write` pass fixed import ordering + two genuine issues (a redundant switch-case in `CheckRunRow.tsx`, two `noNonNullAssertion`s in `deviceFlow.test.ts`); `pnpm typecheck`/`pnpm test` were re-run clean after those fixes. Manual end-to-end smoke on a real repo with a pushed branch + open PR (start the daemon, open the session's /checks route in the web app, observe real check-runs, then `falcon github logout` and confirm the panel flips to not-connected) was **not** exercised — it needs a running daemon + web app + browser + a real GitHub repo/PR, which this text-only sandboxed session can't drive end-to-end; `falcon github login --token` / `status` / `logout` themselves *were* smoke-tested for real in Phase 2 (against a scratch `FALCON_HOME_DIR`, with `status` making one real, read-only `GET https://api.github.com/user` call against a deliberately-fake token to observe the real "invalid token" rejection path — no destructive action, no real account touched).

**Acceptance:** Root `pnpm build && pnpm typecheck && pnpm test` all pass; `pnpm lint` genuinely passes for every file this feature touched (verified via the `rtk proxy` bypass — see above), though the `pnpm lint` command itself can't be run straight in this sandbox; the side panel's Checks tab shows live data when opened from a session with machineId/workspaceId (and the placeholder otherwise); Settings → Git shows the GitHub informational section; design doc §4.4 table and CLAUDE.md mention github.checks. The real-repo browser smoke sequence is the one gap — left for the next stage/reviewer to run against an actual daemon + browser.


## Status

Implementation complete, all five phases. `pnpm build && pnpm typecheck && pnpm test` green across the whole workspace (`@falcon/wire` 111 tests, `falcon` cli 1618 tests incl. 58 new for this feature, `@falcon/web` 818 tests incl. 18 new, `@falcon/server` 316 tests unaffected). Every file this feature added/touched passes `biome check` cleanly (verified via the `rtk proxy` bypass documented in Phase 5's notes above — this sandbox's `rtk` Bash-hook fabricates a bogus OOM warning for every plain `pnpm lint`/`biome` invocation, unrelated to this feature).

**What's real and tested:** the full `github.checks` machine RPC family (wire schemas, daemon handler with real `parseGithubRemote`/state-machine logic, machineRpc.ts registration), `falcon github login|logout|status` (device-flow + `--token` PAT paste, smoke-tested against a scratch home dir + one real read-only GitHub API call), the web `features/github-checks/` area (mock + live data sources, react-query polling, all six UI states render-tested), the `/session/[id]/checks/` route (confirmed via a real `next build` static export), `SessionSidePanel`'s Checks tab going live when threaded a machineId/worktree, and the Settings → Git informational card.

**What's not verified (documented gap, needs a live/browser pass):** the actual end-to-end smoke against a real daemon + real pushed branch + real open GitHub PR, observed through a real browser — this sandbox has no daemon-plus-browser harness to drive that. Also honestly out of scope per the plan's own risk notes (not gaps introduced by this implementation): no Falcon GitHub OAuth app with Device Flow exists yet, so `falcon github login` only works via `--token`/`FALCON_GITHUB_CLIENT_ID` until one is created; fork-workflow PRs and >100-check-run PRs are documented MVP limitations; ETag conditional requests are deferred.

## Test & Review notes (independent verification pass)

Reviewed as a genuinely independent tester (did not write this code), in
`.worktrees/feature-github-pr-ci` on `wf/feature-github-pr-ci`.

**What was checked for real, not just trusted from checked boxes:**
- `pnpm build && pnpm typecheck && pnpm test` run from a clean `--force` (no
  turbo cache) at the repo root: all green, matching the reported counts
  exactly — `@falcon/wire` 111, `falcon` cli 1618, `@falcon/web` 818,
  `@falcon/server` 316, `@falcon/e2e` 1.
- `pnpm lint` genuinely does hang/fail in this sandbox for *every* biome/pnpm
  invocation (`pnpm exec biome --version` fails identically to `pnpm lint`),
  confirming the implementer's own claim rather than trusting it — it's an
  environment-level interception of `pnpm exec`/`npx`, not a lint problem;
  running the installed `@biomejs/biome` binary directly
  (`node node_modules/.pnpm/@biomejs+biome@2.5.4/.../bin/biome`) bypasses it
  and gives real output: 95 pre-existing errors / 132 warnings repo-wide
  (unrelated debt, none in files this feature touches), and a clean 0
  errors/0 warnings on every one of the 26 files this feature actually
  added or touched.
- Read and manually traced `daemon/githubChecks.ts`'s full state machine
  (`parseGithubRemote`'s scp/`ssh://`/`https://` forms, the
  not-pushed/no-pr split via `ls-remote`, 401→no-token, merged-PR mapping)
  against `githubChecks.test.ts`'s 21 cases — all real, not tautological.
- Smoke-tested the CLI for real against a scratch `FALCON_HOME_DIR` (no
  real GitHub account touched): `falcon github login --token` (piped a
  fake PAT via stdin) created `~/.falcon/github.key` at mode `0600`
  (verified via `stat`); `falcon github status` made one real, read-only
  `GET https://api.github.com/user` call and correctly reported "invalid
  token — GitHub rejected it"; `falcon github logout` removed the file;
  `falcon github login` with no client id configured fails fast with the
  documented "--token instead" message rather than hanging. Confirmed via
  `grep` that neither `githubAuth.ts`/`githubChecks.ts`/`commands/github.ts`
  contains any `logger.*` call at all, so the token has no logging surface
  to leak from.
- Verified the `"unknown-method"` string `live-actions.ts` matches against
  is the literal string `daemon/machineRpc.ts` seals for an unrecognized
  RPC target (`errorBox(deps.dek, "unknown-method")`) and that
  `MachineRpcError`'s `.message` is `response.error` verbatim — the
  `DaemonUnsupportedError` mapping is real, not just plausible-looking.
  Traced `machineRpc.ts`'s `github.checks` registration and
  `machineRpc.test.ts`'s sealed round-trip case.
- Read every new web file (`types.ts`, `mock-source.ts`, `live-actions.ts`,
  `use-checks-panel.ts`, `use-live-github-checks-actions.ts`,
  `ChecksPanel.tsx`/`ChecksBody`, `CheckRunRow.tsx`) plus the
  `SessionSidePanel.tsx`/`SessionTimelineScreen.tsx`/settings-git-page
  wiring, and the 18 new web tests (`ChecksPanel.test.ts` 9,
  `live-actions.test.ts` 4, `mock-source.test.ts` 4,
  `use-live-github-checks-actions.test.ts` 1) — all six UI states really
  are exercised via `ChecksBody`'s extracted pure-props render test using
  `renderToStaticMarkup`, matching the codebase's existing
  jsdom-free-render-test convention (`SessionTimelineScreen.tsx`'s own
  precedent).

**Bugs found and fixed in this pass:**
1. **`gitExec.ts`'s `runGit` had no non-interactive/timeout guard, and
   `github.checks` is the first RPC in this family to ever touch the
   network via `git`.** `git.status`/`git.diff`/`git.branches` only ever
   run local, non-network git commands, so this never mattered before.
   `getGithubChecks`'s "not-pushed" vs "no-pr" branch runs a real
   `git ls-remote --heads <remote> <branch>` against the actual configured
   remote — reproduced this for real against a local bare-repo remote and
   confirmed the subprocess call is genuine (not just a `fakeGit`
   stand-in). The daemon is a long-running, headless background process
   with no controlling terminal; a remote that needs interactive
   credentials (an HTTPS remote with no cached credential helper, or a
   GUI `core.askpass` invoked anyway) could hang that `ls-remote` — and
   therefore that whole RPC call — indefinitely, since `execFile` was
   given no `timeout` and git was never told to skip terminal prompts.
   Fixed by adding `GIT_TERMINAL_PROMPT: "0"` to the child's env and a
   15s `timeout` to the shared `runGit`'s `execFile` call — a no-op for
   every existing local-only caller, and directly targeted at the one new
   network-touching call site. This does *not* change the deliberate
   "throw on any git failure other than a missing remote" design decision
   `getGithubChecks`'s own doc comment documents (which is intentional,
   not a gap) — it only bounds how long that throw can take to happen.
2. **`ChecksPanel.tsx`'s check-run list used `key={check.name}` alone.**
   GitHub's check-runs endpoint commonly returns multiple entries with the
   identical `name` for one commit (a workflow re-run creates a new check
   run rather than replacing the old one in the API response), which is a
   React key collision, not just a theoretical one. Fixed by folding the
   array index into the key (`` `${check.name}-${index}` ``), with a
   `biome-ignore lint/suspicious/noArrayIndexKey` comment matching this
   codebase's existing precedent for the same tradeoff
   (`UnifiedDiffViewer.tsx`/`DiffView.tsx`: no stable id exists on the wire
   shape, and the list is replaced wholesale each poll rather than
   reordered in place).

**Verified as correct, not just present** (specifically checked because
they looked like plausible bug locations and turned out fine): PR-state
mapping (open/closed/merged via `merged_at`) only ever runs on
already-open-filtered PRs, so the closed/merged branches are dead-in-practice
but harmless; ISO→unix-seconds timestamp conversion; the `--token` argv
flag genuinely rejects a bare pasted value (`falcon github login --token
gho_x` throws `Unknown "falcon github login" flag`, confirmed by both
reading `args.ts`'s flag loop and its test); 0600 file mode on
`github.key` (confirmed via `stat`, not just code inspection);
`resolveHomeDir`/`readWorkspaceGitConfig`'s home-dir resolution paths are
consistent with `githubAuth.ts`'s own (both fall through to the same
`FALCON_HOME_DIR`-aware default when the daemon calls them with no
explicit override).

**Unresolved / left as-is (flagged, not fixed):** the CLI's `--token` PAT
prompt (`defaultReadSecretLine`) echoes the pasted token to the terminal —
`readline`'s `question()` has no built-in mask, and there was no existing
masked-secret-input precedent elsewhere in this codebase to reuse
(`auth/credentials.ts`'s flows never prompt for a raw secret this way).
Low severity (local terminal echo/scrollback exposure only, same class of
risk the plan's own "one `cat ~/.falcon/github.key` away" risk note
already accepts for the file itself) and out of scope for a same-day fix
without pulling in a masking dependency or hand-rolling raw-mode stdin
handling — noted here for a future pass rather than papered over.

No other correctness gaps found. All five phases' acceptance criteria hold
for real, with the two fixes above applied on top.
