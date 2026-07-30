# Web UX improvements plan — 4 features

**Status:** planning document only. Nothing here has been implemented.
**Scope:** `packages/wire`, `packages/cli` (daemon), `packages/web`. One server-side
note only (no server change is required by any of the four features).

Every claim in this document was verified by reading the source on this branch
(`trankhacvy/malabo`, HEAD `73adb750`). Where the original design brief disagreed with
the code, **the code wins** and the discrepancy is called out inline under a
**⚠ Brief correction** heading. There are five material ones; see
[§0.2](#02-corrections-to-the-original-brief) for the summary — read that first, because
two of them change what the work actually is.

---

## 0. Overview

### 0.1 The four features

| # | Feature | One-line goal | Wire change? | Risk |
|---|---|---|---|---|
| [1](#feature-1--missing-local-git--missing-remote-git) | Missing local git / missing remote | Turn two dead-end error screens (`workspace-not-a-repo`, and a raw `fatal: 'origin' does not appear to be a git repository` on Push) into one-click fixes | **Yes** — 2 new additive RPC pairs (`git.init`, `git.setRemote`) | Medium (first RPCs that create repo state) |
| [2](#feature-2--web-ui-when-the-daemon-is-offlinecrashed) | Daemon offline/crashed UX | A shared `useMachineOnline(machineId)` so every machine-RPC surface disables proactively instead of blocking ~17s on a doomed call | No | Low (pure web) |
| [3](#feature-3--file-tree--diff--file-viewer-adopt-libraries-stop-hand-rolling) | File tree / diff / viewer | Fix a real infinite re-highlight loop, then adopt `@tanstack/react-virtual` + `react-arborist` + `@git-diff-view/react` instead of maintaining hand-rolled renderers | No | Medium-high (3 new deps, biggest diff) |
| [4](#feature-4--new-workspace-creation-flow) | "New workspace" creation | Give the web a way to create a project at all — today it has **none** | No for MVP; **yes** for the phase-2 `git.clone` | Low for MVP |

Cross-links: Feature 2's `useMachineOnline` is consumed by Feature 1's new buttons and
Feature 4's new panel; Feature 3 is independent of all three; Feature 4's phase-2
`git.clone` reuses Feature 1's `gitExec.ts` shelling and the `run.status`-style polling
shape. See [§5. Suggested implementation order](#5-suggested-implementation-order).

### 0.2 Corrections to the original brief

1. **There is no directory-picker UI in the web app.** The brief describes adding a
   "Create new workspace" option "alongside the existing 'Browse existing folder' step".
   That step was deleted in the B5 new-session redesign —
   `packages/web/src/features/session-list/session-list-screen.tsx:59-68` says so
   explicitly ("the old standalone 'New session' wizard/route is retired"). The
   `browseDirectory`/`createDirectory`/`registerWorkspace` actions still exist and are
   still wired to real RPCs (`packages/web/src/features/new-session/live-actions.ts:33-43`),
   but **nothing in the UI calls them**: the only two `runSpawnFlow` call sites
   (`use-inline-spawn.ts:69-75`, `use-review-spawn.ts:51-57`) both hard-decline every
   approval. Feature 4 is therefore *building the entry point*, not extending one. The
   good news is unchanged: the daemon side is 100% done.
2. **There is no 90-second presence sweep on the server.** `machine-presence` is emitted
   in exactly two places, both in `packages/server/src/app/socket.ts` — on a
   machine-scoped socket's connect (`:150-159`) and on its disconnect (`:270-287`). There
   is no periodic sweep in `packages/server/src/app/events/eventRouter.ts` (its only
   presence code is the `buildMachinePresenceEphemeral` builder at `:335-343`). The
   "recently seen" fallback lives client-side: `MACHINE_ONLINE_WINDOW_MS = 3 * 60_000`
   in `packages/web/src/features/session-list/use-machine-presence.ts:68`, backed by the
   `machine-alive` write-behind `lastSeenAt` update at `socket.ts:242-254`. (The 5-minute
   `STALE_SESSION_MACHINE_WINDOW_MS` in `packages/server/src/app/staleSessions.ts:34` is a
   different sweep — it flips *session* rows, not machine presence.)
3. **The RPC grace window is ~17s, not ~10s.** `packages/server/src/app/socket/rpcHandler.ts:45`
   sets `RPC_RECONNECT_GRACE_MS = 15_000`, and it runs *after* an initial lookup with
   `RPC_LOOKUP_FETCH_TIMEOUTS_MS[0] = 2_000` (`:35`, `:231-234`). So a click against an
   offline machine hangs for roughly 17 seconds before `"RPC target not available"`
   (`:236-240`). That makes Feature 2 more valuable than the brief assumed, not less.
4. **The composer does not use a machine RPC.** `sendMessage` goes to a *session* RPC
   target `s:<sessionId>:message` (`packages/web/src/sync/sessionRpc.ts:127-129`, adapter
   at `features/session-control/live-actions.ts:15`), registered by the session process,
   not the daemon. "Machine offline" is a strong *hint* that the session process is also
   gone (it is a child of the same machine), but it is not the same signal. Feature 2
   treats the composer separately and honestly — see [§2.4](#24-web-changes).
5. **`@git-diff-view/react` vs. `react-diff-viewer-continued`:** the brief asked for a
   choice with justification. This plan picks `@git-diff-view/react`. Reasons and the
   losing alternative's tradeoffs are in [§3.2](#32-ux-decision-recap).

One more thing the brief got right but understated: **the file viewer has a genuine
infinite loop**, not just an expensive one. See [§3.1](#31-problem).

### 0.3 Repo facts every section below relies on

- **Machine RPC pipeline.** `packages/cli/src/daemon/machineRpc.ts` — `MACHINE_RPC_METHODS`
  (`:313-347`), the `methods` spec table (`:688-854`), and one uniform
  decrypt → `paramsSchema.safeParse` → handle → `resultSchema.safeParse` → seal path in
  `onRpcRequest` (`:866-923`). A thrown handler error is forwarded verbatim
  (`:918`), and only a `WorkspaceValidationError` gets a typed `code` attached (`:919`).
- **Caller side.** `packages/web/src/sync/machineRpc.ts` — `MachineRpcParams` (`:198-233`),
  `MachineRpcResults` (`:236-271`), `RESULT_SCHEMAS` (`:275-310`). Adding a method means
  three parallel entries here plus two in `machineRpc.ts` daemon-side. `MachineRpcError`
  carries `handlerErrorCode` (`:323-332`), which is how the web reads
  `workspace-missing`/`workspace-not-a-repo`.
- **Write-RPC template.** `gitCommit.ts` / `gitPush.ts` / `gitRenameBranch.ts` all share:
  `deps.git?: GitExec` (default `runGit`), `deps.authorizeWorktree?: WorktreeAuthorizer`
  (default `createRegistryWorktreeAuthorizer()` from `gitWriteGuard.ts:30-39`),
  `await authorizeWorktree(params.worktree)` as the *first* statement, argv-only
  invocation (never a shell), and `GitExecError` on failure. Registration wraps them in
  `withIdempotencyCache` (`machineRpc.ts:500-515`).
- **Test environment (all packages).** `globals: false` — every `describe`/`it`/`expect`/`vi`
  is explicitly imported from `"vitest"` — and `environment: "node"` everywhere.
  `packages/web/vitest.config.ts` in particular has **no jsdom and no
  `@testing-library/react`** (neither is in `packages/web/package.json`'s devDeps, and there
  is no `setupFiles`). Consequences:
  - Components are tested with `renderToStaticMarkup(createElement(X, props))` and
    `expect(html).toContain(...)` string assertions — JSX is not used even in `.test.tsx`
    files (`features/git-diff/components/GitStatusError.test.tsx:1-8`,
    `GitToolbar.test.tsx`'s header comment is the canonical statement of the rule).
  - Hooks are tested with a one-shot render harness that captures the return value
    (`features/git-diff/use-git-panel.test.ts:36-48`); there is no re-render, so only
    side effects and spies can be asserted, via `await vi.waitFor(...)`.
  - Any logic that needs real assertions must be extracted into a pure module, exactly as
    `git-diff-query.ts`, `git-toolbar-state.ts`, `file-tree-logic.ts` and `inline-spawn.ts`
    already are.
- **No `vi.mock` anywhere in this repo.** Dependencies are injected through an explicit
  deps/options parameter, or faked with a hand-written class/factory: `FakeSocket` +
  `baseHandlerDeps()` + `register()` + `callAndAwaitAck()` in
  `packages/cli/src/daemon/machineRpc.test.ts` (which uses **real** `seal`/`open` from
  `@falcon/crypto`, not mocked crypto); `fakePanel(overrides)` / `fakeRpc(call)` /
  `fakeActions(overrides)` / `makeMachine(overrides)` in web. Factory shape is always
  `function fakeX(overrides: Partial<T> = {}): T { return { ...defaults, ...overrides }; }`
  with `vi.fn()` for every callback. Test names are full sentences stating the invariant,
  usually with a doc citation in parentheses, and negative assertions are emphasised
  (`"does NOT cache a rejected attempt"`).
- **Wire additive-only.** `packages/wire/package.json` → `"lint:additive": "tsx scripts/check-additive-vs-base.ts"`,
  which re-derives the base branch's `packages/wire/src` from git and re-fingerprints it
  with this branch's `describeShape`/`isCompatible` (`src/__tests__/schemaShape.ts`).
  `isCompatible` (`:81-131`) ignores *additions* entirely: new object fields, new union
  options, new enum options and new literal values all pass; only a **removed field**, a
  **changed `kind`**, or an **optional→required** narrowing fails. A brand-new exported
  schema is trivially safe (it has no frozen counterpart). What is **not** safe:
  - retyping an existing field (`z.string()` → `z.enum([...])` changes `kind` from
    `leaf` to `enum`);
  - swapping `z.literal([...])` for `z.enum([...])` on an existing field — the exact trap
    documented at `packages/wire/src/rpc.ts:71-81`;
  - making an existing optional field required;
  - deleting a field, or removing a schema from
    `src/__tests__/schemaRegistry.ts` once it is in `__fixtures__/wire-shapes.json`.
  Note that the registry is *not* exhaustive today (`git.remotes`, `worktree.remove`,
  `workspace.unregister`, `workspace.setConfig` are all absent from
  `schemaRegistry.ts:10-112`) — `additiveOnly.test.ts` only warns about that, it does not
  fail. New schemas **should** still be added to the registry and the fixture regenerated
  via `pnpm --filter @falcon/wire exec tsx scripts/snapshot-shapes.ts`.

---

## Feature 1 — Missing local git / missing remote git

### 1.1 Problem

**(a) "This folder isn't set up as a git project." is a dead end.**
`packages/cli/src/daemon/workspacePath.ts:125-144` — `assertWorkspaceStillValid` `stat`s
the directory and then `stat`s `<dir>/.git`, throwing `WorkspaceValidationError` with
`code: "workspace-missing" | "workspace-not-a-repo"` (`:94-111`). It is called by exactly
two handlers: `gitStatus.ts:76` and `gitDiff.ts:99`. `machineRpc.ts:919` attaches that
`.code` to the sealed error box; `sync/machineRpc.ts:396-398` re-throws it as
`MachineRpcError(..., "handler-error", opened.code)`; `use-git-panel.ts:41-47,141`
duck-types it out as `statusErrorCode`; and
`features/git-diff/components/GitStatusError.tsx:14-62` renders the friendly copy.

The *only* action offered there is **"Remove this workspace"**
(`GitStatusError.tsx:50-59` → `panel.removeWorkspace` → `use-git-panel.ts:134-136` →
`live-actions.ts:72-77` → `workspace.unregister`). For `workspace-not-a-repo` that is
close to the worst possible affordance: the user's folder is fine, it is just not a repo
yet, and the one button on screen deletes Falcon's knowledge of it.

Two additional wrinkles found while reading:
- The same `GitStatusError` renders in **both** entry points —
  `GitDiffPanel.tsx:63-65` (full `/dashboard/session/[id]/git/` page) and
  `SessionSidePanel.tsx:146-148` (`ChangesTab`, the rail). Any fix lands in both for free.
- `assertWorkspaceStillValid` is a plain `stat` of `<dir>/.git` by design (`:113-124`), so
  **a subdirectory of a real repo also reports `workspace-not-a-repo`**, even though every
  `git` command would work there. `git init` in that directory would silently create a
  nested repo. The new handler must detect and refuse that case — see [§1.4](#14-daemonbackend-changes).

**(b) Push with no remote surfaces raw git stderr.**
`gitPush.ts:70-80` defaults `remote` to `"origin"` and runs `git push origin <branch>`
with no pre-check. `machineRpc.ts:918` forwards git's own message. `use-git-panel.ts:166`
exposes it as `pushError`. `GitToolbar.tsx:167-173` prints it verbatim in
`text-destructive`. On a repo with no remote that is:

> `fatal: 'origin' does not appear to be a git repository`
> `fatal: Could not read from remote repository.`

That verbatim-stderr behaviour is deliberate for *credential* failures
(`GitToolbar.tsx:19-29` calls it "the credential-failure UX"), and this plan keeps it.
"No remote configured at all" is a different, fully-detectable-in-advance condition.

**(c) The precedent for modelling this already exists and is unused here.**
`GithubChecksResultSchema.state` (`packages/wire/src/rpc.ts:437-458`) enumerates
`"no-token" | "unsupported-remote" | "not-pushed" | "no-pr" | "ok"`, each computed fresh
by `githubChecks.ts:179-246` and rendered as derived copy. The Git panel has no equivalent.

**(d) `git.remotes` already exists and the Git panel never calls it.**
`GitRemotesParamsSchema`/`GitRemotesResultSchema` (`rpc.ts:190-205`), handler
`gitRemotes.ts:29-43` (`git remote -v`, `(fetch)` rows only), registered at
`machineRpc.ts:734-738`, typed caller-side at `sync/machineRpc.ts:210,248,287`. Only
Workspace Settings uses it. This is why part (b) needs **no new read RPC**.

### 1.2 UX decision recap

Two new **safe, non-destructive, explicitly-user-invoked** daemon RPCs, modelled
line-for-line on the existing mutating git RPCs:

- **`git.init`** — runs `git init` in an already-registered workspace directory that has
  no `.git`. Refuses (does not throw) when the directory is already a repo or is nested
  inside one.
- **`git.setRemote`** — `git remote add <name> <url>`, or `git remote set-url` when the
  name already exists. Never removes a remote, never rewrites an unrelated one.

Web:

- `GitStatusError.tsx` gains an **"Initialize git"** primary button in the
  `workspace-not-a-repo` branch. "Remove this workspace" demotes to a link, satisfying
  the CLAUDE.md auth/UX rule #5 ("never put a destructive button next to a safe one" —
  precedent `components/auth/start-over-link.tsx`). The `workspace-missing` branch is
  unchanged: there is nothing safe to offer for a folder that is gone, and `git init`
  would be actively wrong.
- A new pure module `features/git-diff/push-readiness.ts` derives a
  `GithubChecksResult.state`-style union from data the panel already has
  (`git.status` + a new `git.remotes` fetch). When it is `"no-remote"`, `GitToolbar`
  disables Push/Force Push/Commit&Push *before* the click and offers **"Add a remote"**
  inline instead of letting git's stderr teach the user.
- Both fixes invalidate through the existing TanStack Query keys, so the panel
  self-updates with no manual refresh (CLAUDE.md rule #6).

**Why no new wire schema for (b):** `git.remotes` already returns everything needed, and
design principle #3 ("never stored, always recomputed") says the state should be derived
at the edge. Putting a `pushReadiness` state on the daemon would mean a third round-trip
and a new schema for zero new information. `github.checks`'s state *does* live daemon-side
because it needs a machine-local GitHub token and network access (`githubChecks.ts:8`,
`:30`) — that reasoning does not transfer.

### 1.3 Wire protocol changes

Purely additive: four new exported schemas, no existing schema touched. Append to
`packages/wire/src/rpc.ts` after `GitRenameBranchResultSchema` (`:389`), keeping the
`git.*` family together.

```ts
// `git.init` machine RPC (docs/web-ux-improvements-plan.md Feature 1): the
// recovery action behind the Git panel's `workspace-not-a-repo` state
// (`workspacePath.ts`'s `WorkspaceValidationErrorCode`) — a registered
// workspace whose folder is real but was never `git init`ed. Joins
// `git.commit`/`git.push`/`git.renameBranch` as a *mutating* git RPC and is
// gated on the same registered-workspace authorizer, but is deliberately
// non-destructive: `git init` on an existing repository is refused (see
// `state` below), never allowed to re-init or clobber anything.
//
// `initialBranch` maps to `git init --initial-branch=<name>`; omitted, git's
// own `init.defaultBranch` config wins. Validated with the same
// `assertSafeBranchName` guard `git.renameBranch` uses — this value becomes
// an argv element next to a `--`-prefixed flag.
export const GitInitParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
  initialBranch: z.string().optional(),
});
export type GitInitParams = z.infer<typeof GitInitParamsSchema>;

// Modelled on `GithubChecksResultSchema.state` (above): every outcome the
// panel's copy derives from is its own enumerated value, so no caller ever
// has to string-match an error message.
//   - "initialized":         a real `git init` ran; `branch` is the new HEAD.
//   - "already-repo":        `<worktree>/.git` already exists — a no-op, not
//                            an error (idempotent from the caller's view, the
//                            same contract `fs.mkdir`/`workspace.register`
//                            already have).
//   - "inside-existing-repo": the directory has no `.git` of its own but IS
//                            inside another repository's worktree
//                            (`git rev-parse --show-toplevel` succeeded).
//                            `git init` here would create a nested repo, which
//                            is almost never what the user meant — refused,
//                            with `existingRoot` so the UI can say where the
//                            real repo root is. NOTE this case is reachable
//                            today precisely because `assertWorkspaceStillValid`
//                            only `stat`s `<dir>/.git` and therefore reports
//                            `workspace-not-a-repo` for a perfectly usable
//                            subdirectory of a repo.
export const GitInitResultSchema = z.object({
  state: z.enum(["initialized", "already-repo", "inside-existing-repo"]),
  /** The checked-out branch after a successful `initialized` (or the existing repo's current branch for `already-repo`); absent when it can't be resolved. */
  branch: z.string().optional(),
  /** Absolute toplevel of the repository this directory already belongs to — set only for `"inside-existing-repo"`. */
  existingRoot: z.string().optional(),
});
export type GitInitResult = z.infer<typeof GitInitResultSchema>;

// `git.setRemote` machine RPC (docs/web-ux-improvements-plan.md Feature 1):
// configures a remote URL for a repository that has none, so the Git panel's
// Push button has somewhere to push. Additive and non-destructive by
// construction — `git remote add` when `name` is new, `git remote set-url`
// when it already exists; there is deliberately NO remove/rename path over
// the wire (a caller that wants one uses a terminal, same local-consent
// boundary `workspace.setConfig` keeps for script strings).
//
// `url` is passed as its own argv element and is validated only for the
// argv-injection hazard (a leading `-`), NOT for reachability: Falcon manages
// no git credentials (see `GitPushParamsSchema`'s own note), so whether the
// URL actually works is git's business at push time, not this RPC's.
export const GitSetRemoteParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
  /** Remote name; omitted means `"origin"`, matching `git.push`'s own default. */
  name: z.string().optional(),
  url: z.string(),
});
export type GitSetRemoteParams = z.infer<typeof GitSetRemoteParamsSchema>;

export const GitSetRemoteResultSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
  url: z.string(),
  /** `true` when the remote did not exist and was added; `false` when an existing remote's URL was updated in place. */
  created: z.boolean(),
});
export type GitSetRemoteResult = z.infer<typeof GitSetRemoteResultSchema>;
```

No `src/index.ts` edit is needed — it is `export * from "./rpc"` (`packages/wire/src/index.ts:18`).
Register all four in `packages/wire/src/__tests__/schemaRegistry.ts` (alongside
`GitRenameBranch*` at `:42-43`) and regenerate the fixture:

```bash
pnpm --filter @falcon/wire exec tsx scripts/snapshot-shapes.ts
pnpm --filter @falcon/wire run lint:additive   # what CI runs against the base branch
```

**Additive-safety note for reviewers.** New *exports* can never fail `lint:additive` —
`isCompatible` is only ever invoked for names present in the base branch's registry
(`scripts/check-additive-vs-base.ts`). What would fail: adding a value to
`GitInitResultSchema.state` is *safe* (`isCompatible`'s `enum` case at
`schemaShape.ts:122-125` only requires every *previous* option to still exist), but
converting `state` to `z.literal([...])` later, or making `existingRoot` required, is not.

### 1.4 Daemon changes

#### New file: `packages/cli/src/daemon/gitInit.ts`

```ts
/**
 * `git.init` machine RPC handler (docs/web-ux-improvements-plan.md Feature 1
 * — the recovery action behind the Git panel's `workspace-not-a-repo` state).
 *
 * Same injectable `deps.git?`/`deps.authorizeWorktree?` shape as
 * `gitCommit.ts`/`gitPush.ts`/`gitRenameBranch.ts` — see `gitCommit.ts`'s doc
 * comment for why the mutating handlers, unlike their read-only siblings,
 * gate on the registered-workspace authorizer.
 *
 * The authorizer is load-bearing beyond the usual reason here: it resolves
 * through `isWithinRegisteredWorkspace`, which `realpath`s the directory
 * first (`workspace/registry.ts`) and returns `null` for a path that doesn't
 * exist. So a `workspace-missing` folder can never reach `git init` — this
 * handler refuses it before creating anything, and it deliberately does NOT
 * `mkdir` a missing directory (that stays `fs.mkdir`'s job, behind its own
 * explicit user approval).
 *
 * Two refusals are modeled as result STATES rather than thrown errors,
 * following `githubChecks.ts`'s precedent ("never throw for an expected
 * nothing-to-do case"):
 *   - `already-repo`: `<worktree>/.git` exists. Making this idempotent
 *     matters because a lost RPC ack is retried with the same
 *     `idempotencyKey` — and even though `machineRpc.ts` caches the prior
 *     result, a *different* key (a second device) must not error either.
 *   - `inside-existing-repo`: no local `.git`, but `git rev-parse
 *     --show-toplevel` resolves to some ancestor. `git init` here would
 *     create a NESTED repository, which silently breaks the parent's view of
 *     those files. This is a real, reachable case, not a theoretical one:
 *     `workspacePath.ts`'s `assertWorkspaceStillValid` only `stat`s
 *     `<dir>/.git`, so a plain subdirectory of a working repo already reports
 *     `workspace-not-a-repo` to the web panel.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import type { GitInitParams, GitInitResult } from "@falcon/wire";
import { type GitExec, GitExecError, runGit } from "./gitExec.js";
import { assertSafeBranchName } from "./gitWorktree.js";
import { createRegistryWorktreeAuthorizer, type WorktreeAuthorizer } from "./gitWriteGuard.js";

export interface GitInitDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to the real registered-workspace check (`gitWriteGuard.ts`). */
  authorizeWorktree?: WorktreeAuthorizer;
  /** Injectable for tests; defaults to a real `stat` of `<worktree>/.git` — the same check `workspacePath.ts` makes. */
  hasGitDir?: (worktree: string) => Promise<boolean>;
}

async function defaultHasGitDir(worktree: string): Promise<boolean> {
  return stat(path.join(worktree, ".git")).then(
    () => true,
    () => false,
  );
}

/** Resolves the toplevel of the repository `worktree` already belongs to, or `null` when it belongs to none. Never throws — a non-repo directory makes `git rev-parse` exit non-zero, which is the answer, not a failure. */
async function resolveExistingRoot(git: GitExec, worktree: string): Promise<string | null> {
  try {
    const output = (await git(["rev-parse", "--show-toplevel"], worktree)).trim();
    return output === "" ? null : output;
  } catch {
    return null;
  }
}

/** Resolves the current branch name, or `undefined` on a detached/unborn HEAD that `git` can't name. */
async function currentBranch(git: GitExec, worktree: string): Promise<string | undefined> {
  try {
    const name = (await git(["rev-parse", "--abbrev-ref", "HEAD"], worktree)).trim();
    return name === "" || name === "HEAD" ? undefined : name;
  } catch {
    // A freshly-`git init`ed repo has an unborn HEAD; `symbolic-ref` still
    // names it where `rev-parse` refuses.
    try {
      const ref = (await git(["symbolic-ref", "--short", "HEAD"], worktree)).trim();
      return ref === "" ? undefined : ref;
    } catch {
      return undefined;
    }
  }
}

/** Runs `git init` in `params.worktree`. Throws `GitExecError` on an unauthorized worktree, an unsafe `initialBranch`, or a genuine `git init` failure; refuses (as a result `state`) an already-initialized or nested directory. */
export async function handleGitInit(
  params: GitInitParams,
  deps: GitInitDeps = {},
): Promise<GitInitResult> {
  const git = deps.git ?? runGit;
  const authorizeWorktree = deps.authorizeWorktree ?? createRegistryWorktreeAuthorizer();
  const hasGitDir = deps.hasGitDir ?? defaultHasGitDir;

  await authorizeWorktree(params.worktree);

  if (params.initialBranch !== undefined) assertSafeBranchName(params.initialBranch);

  if (await hasGitDir(params.worktree)) {
    return { state: "already-repo", branch: await currentBranch(git, params.worktree) };
  }

  const existingRoot = await resolveExistingRoot(git, params.worktree);
  if (existingRoot !== null) {
    return { state: "inside-existing-repo", existingRoot };
  }

  const args = ["init", ...(params.initialBranch ? [`--initial-branch=${params.initialBranch}`] : [])];
  await git(args, params.worktree);

  return { state: "initialized", branch: await currentBranch(git, params.worktree) };
}
```

`assertSafeBranchName` is already exported from `gitWorktree.ts` and already reused by
`gitRenameBranch.ts:26,55-56` — same import, same rejection semantics
(`GitWorktreeError`, which `machineRpc.ts:918` forwards as its message like any other).

#### New file: `packages/cli/src/daemon/gitSetRemote.ts`

```ts
/**
 * `git.setRemote` machine RPC handler (docs/web-ux-improvements-plan.md
 * Feature 1 — "this repo has no remote, add one" from the Git panel's Push
 * error path).
 *
 * Same injectable `deps.git?`/`deps.authorizeWorktree?` shape as
 * `gitCommit.ts`/`gitPush.ts`. Deliberately additive-only in effect: `git
 * remote add` for a new name, `git remote set-url` for an existing one, and
 * no path at all to `git remote remove`/`rename` — removing a remote is a
 * destructive act with no undo from a phone, and nothing in the web UI needs
 * it.
 *
 * `name` and `url` are both guarded against the leading-`-` argv-injection
 * hazard the same way `gitPush.ts`'s `assertSafeRefName` guards its own
 * remote/branch (a `--config=...`-shaped "url" would otherwise be parsed as a
 * `git remote` option). The URL is NOT validated for scheme, host or
 * reachability: Falcon manages no git credentials (`gitPush.ts`'s doc
 * comment), so "does this remote actually work" is answered by the user's own
 * next push, with git's own stderr — not fabricated here.
 */
import type { GitSetRemoteParams, GitSetRemoteResult } from "@falcon/wire";
import { type GitExec, GitExecError, runGit } from "./gitExec.js";
import { createRegistryWorktreeAuthorizer, type WorktreeAuthorizer } from "./gitWriteGuard.js";

export interface GitSetRemoteDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to the real registered-workspace check (`gitWriteGuard.ts`). */
  authorizeWorktree?: WorktreeAuthorizer;
}

/** Same hazard, and same shape, as `gitPush.ts`'s own `assertSafeRefName` — kept as a local copy so this handler's errors stay a `GitExecError`, matching every other error it can throw. */
function assertSafeArg(kind: "remote name" | "remote url", value: string): void {
  if (value.trim() === "" || value.startsWith("-")) {
    throw new GitExecError(`unsafe ${kind}: ${value}`);
  }
}

/** Returns whether a remote called `name` is already configured. */
async function remoteExists(git: GitExec, worktree: string, name: string): Promise<boolean> {
  const output = await git(["remote"], worktree);
  return output
    .split("\n")
    .map((line) => line.trim())
    .includes(name);
}

/** Adds (or updates the URL of) `params.name` in `params.worktree`. Throws `GitExecError` on an unauthorized worktree, an unsafe name/url, or any `git` failure. */
export async function handleGitSetRemote(
  params: GitSetRemoteParams,
  deps: GitSetRemoteDeps = {},
): Promise<GitSetRemoteResult> {
  const git = deps.git ?? runGit;
  const authorizeWorktree = deps.authorizeWorktree ?? createRegistryWorktreeAuthorizer();

  await authorizeWorktree(params.worktree);

  const name = params.name ?? "origin";
  assertSafeArg("remote name", name);
  assertSafeArg("remote url", params.url);

  const exists = await remoteExists(git, params.worktree, name);
  await git(
    exists ? ["remote", "set-url", name, params.url] : ["remote", "add", name, params.url],
    params.worktree,
  );

  return { ok: true, name, url: params.url, created: !exists };
}
```

#### Wiring in `packages/cli/src/daemon/machineRpc.ts`

Five mechanical edits, each mirroring `git.commit`'s existing lines:

1. Imports (near `:286-292`):
   ```ts
   import { handleGitInit as handleGitInitDefault } from "./gitInit.js";
   import { handleGitSetRemote as handleGitSetRemoteDefault } from "./gitSetRemote.js";
   ```
   plus the four new wire types/schemas in the `@falcon/wire` import block.
2. `MACHINE_RPC_METHODS` (`:313-347`) — add `"git.init"`, `"git.setRemote"` after
   `"git.renameBranch"`.
3. `MachineRpcDeps` (after `:380`):
   ```ts
   /** Backs the `git.init` RPC (docs/web-ux-improvements-plan.md Feature 1). Injectable for tests; defaults to `gitInit.ts`'s real `git init`, gated on the registered-workspace authorizer. Throws on failure; an already-initialized/nested directory resolves as a result `state`, not a throw. */
   gitInit?: (params: GitInitParams) => Promise<GitInitResult>;
   /** Backs the `git.setRemote` RPC. Injectable for tests; defaults to `gitSetRemote.ts`'s real `git remote add`/`set-url`, gated on the registered-workspace authorizer. Throws on failure. */
   gitSetRemote?: (params: GitSetRemoteParams) => Promise<GitSetRemoteResult>;
   ```
4. Idempotency caching (after `:616`) — both are mutating, so both get the cache, and
   `git.init` additionally gets the worktree-keyed resource guard for the same reason
   `run.start` has one (`:632-634`): two devices tapping "Initialize git" concurrently
   with different keys must join one attempt, not race two `git init` calls at the same
   path.
   ```ts
   // `git.init`/`git.setRemote` (docs/web-ux-improvements-plan.md Feature 1)
   // join `git.commit`/`git.push`/`git.renameBranch` as mutating git RPCs
   // that need idempotency-key replay: a lost-ack retry must replay the prior
   // result rather than re-run the effect. `git.init` also takes the
   // worktree-keyed resource guard (generalized from `run.start`'s own,
   // `withResourceGuard` above) so two devices clicking "Initialize git" at
   // once collapse into a single `git init` attempt for that directory.
   const cachedGitInit = withIdempotencyCache(
     withResourceGuard(deps.gitInit ?? handleGitInitDefault, (params) => params.worktree),
   );
   const cachedGitSetRemote = withIdempotencyCache(deps.gitSetRemote ?? handleGitSetRemoteDefault);
   ```
5. `methods` table (after `:768`):
   ```ts
   "git.init": {
     paramsSchema: GitInitParamsSchema,
     resultSchema: GitInitResultSchema,
     handle: cachedGitInit as (params: unknown) => Promise<unknown>,
   },
   "git.setRemote": {
     paramsSchema: GitSetRemoteParamsSchema,
     resultSchema: GitSetRemoteResultSchema,
     handle: cachedGitSetRemote as (params: unknown) => Promise<unknown>,
   },
   ```

No server change. The relay is method-agnostic (`rpcHandler.ts` only routes on `target`).

### 1.5 Web changes

#### `packages/web/src/sync/machineRpc.ts`

Three parallel additions — `MachineRpcParams` (`:213`), `MachineRpcResults` (`:251`),
`RESULT_SCHEMAS` (`:290`) — plus the type/schema imports and re-exports:

```ts
"git.init": GitInitParams;
"git.setRemote": GitSetRemoteParams;
// ...
"git.init": import("@falcon/wire").GitInitResult;
"git.setRemote": import("@falcon/wire").GitSetRemoteResult;
// ...
"git.init": GitInitResultSchema,
"git.setRemote": GitSetRemoteResultSchema,
```

#### `packages/web/src/features/git-diff/types.ts`

Extend `GitDiffActions` (`:36-61`) — every implementation must be updated in lockstep:
`live-actions.ts`, `mock-source.ts`, `use-live-git-diff-actions.ts`'s
`pendingGitDiffActions()`, and every `fakeActions()` in tests.

```ts
  /** Runs `git init` in `worktree` (the daemon's `git.init` RPC) — the recovery action offered when `fetchStatus` reports `workspace-not-a-repo`. Refusals are result states, not throws: `"already-repo"` (someone else got there first) and `"inside-existing-repo"` (this folder is a subdirectory of another repo; `existingRoot` says which). Throws only on a real failure (unauthorized worktree, git error, unreachable machine). */
  initRepo(worktree: string): Promise<GitInitResult>;
  /** Lists `worktree`'s configured remotes (`git.remotes` — already served by the daemon since the Workspace Settings Git tab landed, just never called from this panel). Backs `push-readiness.ts`'s `"no-remote"` derivation. Throws on failure; an empty array means "no remotes", not an error. */
  listRemotes(worktree: string): Promise<GitRemoteInfo[]>;
  /** Adds (or updates) a remote URL in `worktree` (`git.setRemote`). `name` defaults to `"origin"`. Never removes a remote. Throws on failure. */
  setRemote(worktree: string, url: string, name?: string): Promise<GitSetRemoteResult>;
```

#### `packages/web/src/features/git-diff/live-actions.ts`

```ts
    async initRepo(worktree) {
      return rpc.call("git.init", { idempotencyKey: crypto.randomUUID(), worktree });
    },

    async listRemotes(worktree) {
      const result = await rpc.call("git.remotes", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
      });
      return result.remotes;
    },

    async setRemote(worktree, url, name) {
      return rpc.call("git.setRemote", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
        url,
        name,
      });
    },
```

#### New file: `packages/web/src/features/git-diff/push-readiness.ts`

Pure, no React — the house pattern for anything that needs real assertions in this
package (`git-diff-query.ts`, `git-toolbar-state.ts`, `inline-spawn.ts`).

```ts
import type { GitRemoteInfo, GitStatusResult } from "@falcon/wire";

/**
 * Whether the Git panel's Push button can possibly succeed, derived — never
 * stored — from data the panel already holds (design principle #3). Modeled
 * on `@falcon/wire`'s `GithubChecksResult.state`: every distinct empty/blocked
 * case is its own value so the UI renders derived copy instead of
 * string-matching git's stderr (`GitToolbar.tsx` prints `pushError` verbatim
 * today, which is the right behaviour for a CREDENTIAL failure and the wrong
 * one for "there is no remote to push to" — a condition fully knowable before
 * the click).
 *
 * Deliberately NOT a daemon-side state like `github.checks`'s: that one needs
 * a machine-local GitHub token and a network round-trip, so it has to be
 * computed where those live. This one is a pure function of `git.status` +
 * `git.remotes`, both of which the panel can already fetch.
 *
 *   - "unknown":      remotes haven't loaded yet — never render a blocked
 *                     state on a query that simply hasn't resolved (same
 *                     "undefined means don't-know-yet" rule as
 *                     `use-preview-panel.ts`'s `deriveCloudflaredMissing`).
 *   - "no-remote":    the repo has no remotes at all. Push is impossible;
 *                     offer "Add a remote" instead.
 *   - "detached":     `git.status` reports HEAD detached — `gitPush.ts` throws
 *                     "cannot push: HEAD is detached" for exactly this, so
 *                     catch it before the round-trip.
 *   - "no-upstream":  remotes exist but this branch has none. Push still
 *                     works; it just needs `-u` (`setUpstream`), which the UI
 *                     can pass automatically instead of surfacing git's
 *                     "has no upstream branch" hint.
 *   - "ready":        nothing known to be in the way. Any failure from here on
 *                     is a genuine git/credential error and keeps today's
 *                     verbatim-stderr treatment.
 */
export type PushReadiness = "unknown" | "no-remote" | "detached" | "no-upstream" | "ready";

export function derivePushReadiness(
  status: GitStatusResult | undefined,
  remotes: GitRemoteInfo[] | undefined,
  branches: { name: string; isCurrent: boolean; upstream?: string }[],
): PushReadiness {
  if (status === undefined || remotes === undefined) return "unknown";
  if (status.branch === "" || status.branch === "(detached)") return "detached";
  if (remotes.length === 0) return "no-remote";
  const current = branches.find((b) => b.isCurrent);
  if (current && current.upstream === undefined) return "no-upstream";
  return "ready";
}

/** Copy for each blocked state — plain language, no internal vocabulary (CLAUDE.md auth/UX rule #4). `"ready"`/`"unknown"` have none: they render nothing. */
export const PUSH_READINESS_COPY: Partial<Record<PushReadiness, string>> = {
  "no-remote": "This project has no remote yet, so there's nowhere to push.",
  detached: "This project isn't on a branch right now, so there's nothing to push.",
};
```

`status.branch` for a detached HEAD comes from `git status --porcelain=v2 --branch`'s
`# branch.head` line, which git writes as `(detached)`; `gitStatus.ts:80` also defaults
`branch` to the literal `"HEAD"` when no header line was seen. Both are covered above.

#### `packages/web/src/features/git-diff/use-git-panel.ts`

Add a remotes query (enabled only once status succeeded, mirroring the existing
`branchesQuery` guard at `:67-71`), two mutations, and expose the derived readiness.

```ts
  const remotesQuery = useQuery({
    queryKey: ["git-remotes", worktree],
    queryFn: () => actions.listRemotes(worktree),
    enabled: statusQuery.isSuccess,
  });

  // known-issues.md #3 / this plan's Feature 1: offered when `statusErrorCode`
  // is "workspace-not-a-repo" — a real folder that was simply never `git
  // init`ed. Invalidates status/diff/branches/remotes on success so the panel
  // flips straight from the error state to a live repo with no manual refresh.
  const initRepoMutation = useMutation({
    mutationFn: () => actions.initRepo(worktree),
    onSuccess: (result) => {
      if (result.state === "inside-existing-repo") return; // refused — nothing changed
      invalidateStatusAndDiff();
      void queryClient.invalidateQueries({ queryKey: ["git-branches", worktree] });
      void queryClient.invalidateQueries({ queryKey: ["git-remotes", worktree] });
    },
  });

  const setRemoteMutation = useMutation({
    mutationFn: ({ url, name }: { url: string; name?: string }) =>
      actions.setRemote(worktree, url, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["git-remotes", worktree] });
      void queryClient.invalidateQueries({ queryKey: ["git-status", worktree] });
    },
  });
```

Returned additions:

```ts
    remotes: remotesQuery.data,
    pushReadiness: derivePushReadiness(statusQuery.data, remotesQuery.data, branchesQuery.data ?? []),

    initRepo: initRepoMutation.mutate,
    isInitRepoPending: initRepoMutation.isPending,
    initRepoError: initRepoMutation.error instanceof Error ? initRepoMutation.error.message : null,
    initRepoResult: initRepoMutation.data,

    setRemote: setRemoteMutation.mutate,
    isSetRemotePending: setRemoteMutation.isPending,
    setRemoteError: setRemoteMutation.error instanceof Error ? setRemoteMutation.error.message : null,
```

Also add `["git-remotes", worktree]` to the existing stub→real `actions`-swap
invalidation effect (`:86-95`), for the same reason branches is already there.

#### `packages/web/src/features/git-diff/components/GitStatusError.tsx`

```tsx
export function GitStatusError({ panel }: { panel: GitPanelState }) {
  const {
    statusError,
    statusErrorCode,
    removeWorkspace,
    isRemoveWorkspacePending,
    removeWorkspaceDone,
    initRepo,
    isInitRepoPending,
    initRepoError,
    initRepoResult,
  } = panel;
  const workspaceProblem = statusErrorCode && WORKSPACE_ERROR_COPY[statusErrorCode];

  if (workspaceProblem) {
    // "Initialize git" is only ever offered for `workspace-not-a-repo`: for
    // `workspace-missing` the folder itself is gone, and `git init` would be
    // both impossible (the daemon's registry authorizer refuses a path that
    // doesn't resolve) and wrong (it can't recreate the user's files).
    const canInitialize = statusErrorCode === "workspace-not-a-repo";

    return (
      <div className="flex flex-col items-start gap-3 p-4 text-sm">
        <p className="text-muted-foreground">{workspaceProblem}</p>

        {canInitialize && initRepoResult?.state === "inside-existing-repo" && (
          <p className="text-muted-foreground">
            This folder is already part of the project at{" "}
            <code className="rounded bg-muted px-1 py-0.5">{initRepoResult.existingRoot}</code> —
            open that project instead of starting a new one here.
          </p>
        )}
        {canInitialize && initRepoError && (
          <p className="text-destructive">{initRepoError}</p>
        )}

        {canInitialize && initRepoResult?.state !== "inside-existing-repo" && (
          <Button size="sm" disabled={isInitRepoPending} onClick={() => initRepo()}>
            {isInitRepoPending ? "Setting up…" : "Set up git here"}
          </Button>
        )}

        {/* Destructive action stays a link, never a button next to a safe one
            (CLAUDE.md auth/UX rule #5 — same shape as
            components/auth/start-over-link.tsx), and states its consequence. */}
        {removeWorkspaceDone ? (
          <p className="text-muted-foreground">
            Removed. You can add it again from a new session's folder picker once it's back in
            place.
          </p>
        ) : (
          <button
            type="button"
            disabled={isRemoveWorkspacePending}
            onClick={() => removeWorkspace()}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
          >
            {isRemoveWorkspacePending
              ? "Removing…"
              : "Forget this project — Falcon stops tracking the folder, nothing on disk changes"}
          </button>
        )}
      </div>
    );
  }
  // ... unchanged destructive fallback
}
```

Note the button label avoids `git init` jargon in the primary path ("Set up git here").
`WORKSPACE_ERROR_COPY` is already exported and reused by `GitDiffPanel.tsx:86` for the
diff error — leave it untouched.

#### `packages/web/src/features/git-diff/components/GitToolbar.tsx`

Gate the three push-shaped buttons on `pushReadiness` and add an inline "add a remote"
affordance. `gitOperationPending` (`:71-72`) stays exactly as it is; this composes with it.

```tsx
  const pushBlocked = panel.pushReadiness === "no-remote" || panel.pushReadiness === "detached";
  const blockedCopy = PUSH_READINESS_COPY[panel.pushReadiness];
  // A branch with no upstream still pushes fine — it just needs `-u`. Pass it
  // automatically rather than surfacing git's own "has no upstream branch"
  // hint and making the user re-click.
  const pushOptions = panel.pushReadiness === "no-upstream" ? { setUpstream: true } : {};
```

…then `disabled={gitOperationPending || pushBlocked}` on Push / Commit&Push / Force Push,
`onClick={() => panel.push(pushOptions)}`, and below the row:

```tsx
  {blockedCopy && (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{blockedCopy}</span>
      {panel.pushReadiness === "no-remote" && (
        <Button size="sm" variant="outline" onClick={() => setAddRemoteOpen(true)}>
          Add a remote
        </Button>
      )}
    </div>
  )}
```

`AddRemoteDialog` is a new sibling component under `components/`, structurally a clone of
the existing force-push `Dialog` block (`GitToolbar.tsx:176-200`): one `Input` for the URL,
one for the name (prefilled `origin`), Cancel + Save, `panel.setRemoteError` rendered
inline in `text-destructive`. Its submit-validation logic goes in
`git-toolbar-state.ts` next to `resolveCommitSubmit`/`resolveBranchRenameSubmit` so it is
unit-testable without a DOM:

```ts
/** Normalizes the Add-remote dialog's two fields into `setRemote` params, or `null` when the URL is blank (nothing to submit). Trims both; an empty name falls back to `undefined` so the daemon applies its own `"origin"` default rather than this UI hard-coding it in two places. */
export function resolveSetRemoteSubmit(
  url: string,
  name: string,
): { url: string; name?: string } | null {
  const trimmedUrl = url.trim();
  if (trimmedUrl === "") return null;
  const trimmedName = name.trim();
  return trimmedName === "" ? { url: trimmedUrl } : { url: trimmedUrl, name: trimmedName };
}
```

### 1.6 Testing plan

Daemon (`vitest`, injectable fakes only — no real git, no real filesystem, matching
`gitCommit.test.ts:1-48`):

- **`packages/cli/src/daemon/gitInit.test.ts`** (new)
  - runs `["init"]` in the worktree and returns `{state:"initialized", branch:"main"}`;
    asserts `authorizeWorktree` was called exactly once with the worktree, **before** any
    `git` call (assert on call ordering via a shared `calls: string[]` array, as
    `gitCommit.test.ts:24-38` does).
  - `initialBranch: "trunk"` → argv is `["init", "--initial-branch=trunk"]`.
  - `initialBranch: "--upload-pack=evil"` → rejects, and **`git` is never called**.
  - `hasGitDir: async () => true` → `{state:"already-repo"}`, no `["init"]` in `calls`.
  - `hasGitDir: async () => false` + a `git` fake whose `rev-parse --show-toplevel`
    resolves `/repo` → `{state:"inside-existing-repo", existingRoot:"/repo"}`, no `init`.
  - an authorizer that rejects → the promise rejects and `git` is never called (this is
    the `workspace-missing` guarantee).
  - `git` rejecting on `["init"]` → rejects with that `GitExecError` (no swallowing).
- **`packages/cli/src/daemon/gitSetRemote.test.ts`** (new)
  - `git remote` fake returning `""` → argv `["remote","add","origin",url]`, result
    `{created:true}`.
  - fake returning `"origin\nupstream"` with `name:"origin"` → `["remote","set-url",…]`,
    `{created:false}`.
  - explicit `name:"upstream"` is honoured.
  - `url: "--upload-pack=touch /tmp/pwn"` → rejects, `git` never called past the
    existence probe.
  - unauthorized worktree → rejects before any `git` call.
- **`packages/cli/src/daemon/machineRpc.test.ts`** (extend) — one `describe` block per new
  method, following that file's exact five-test template (copy `git.commit`'s block
  verbatim and rename), using `FakeSocket` + `register(socket, { gitInit })` +
  `callAndAwaitAck(socket, "git.init", seal(params, DEK))` and real `open`/`seal`:
  1. decrypts params, calls the injected dep exactly once with them, seals the result;
  2. a throwing dep produces `{ok:false, error:"<message>"}`;
  3. params failing schema validation produce `{ok:false, error:"invalid-params"}`
     (e.g. `git.init` with no `worktree`);
  4. a retried `idempotencyKey` with the same params replays and invokes the dep **once**;
  5. a rejected attempt is **not** cached — a retry re-runs the dep.
  Plus, for `git.init`, a `withResourceGuard` test: two concurrent calls with *different*
  keys but the same `worktree` join one attempt (mirrors the existing `run.start` guard
  test). The registration smoke test at the top of the file is driven by
  `MACHINE_RPC_METHODS`, so it picks up both new targets with no edit.

  **Optional, and worth it:** `machineRpc.test.ts` has a "with the real default (no
  mocked-away side effect)" nested-`describe` precedent (the `workspace.register` block)
  that points `FALCON_HOME_DIR` at a `mkdtemp` directory and exercises the real, injected-
  dep-free handler, asserting the durable side effect rather than "some function got
  called". `git.init` is a good candidate: register a temp directory as a workspace, call
  the RPC with **no** `gitInit` override, and assert a real `.git` directory now exists.
  That is the only test in this plan that shells out to real `git`, so it belongs in that
  block and nowhere else — every unit test above stays fake-only.

Wire:

- **`packages/wire/src/rpc.test.ts`** (extend) — a new `describe("git.init / git.setRemote")`
  block of `safeParse(...).success` assertions in the house style: required vs. optional
  fields spelled out in the test name; `initialBranch`/`name` optional; `state` rejects an
  unknown value; `ok: z.literal(true)` rejects `false`.
- **`packages/wire/src/rpc.test.ts`'s cross-cutting suite** (extend) — the existing
  `describe("idempotencyKey on caller-retriable machine RPCs")` at `:95-96` enumerates every
  machine-RPC params schema and asserts a missing `idempotencyKey` is rejected. **Both new
  params schemas must be added there** — it is the one place that would otherwise silently
  miss them.
- **`packages/wire/src/__tests__/additiveOnly.test.ts`** — no edit needed; it generates one
  `it` per fixture entry. Just regenerate the fixture and confirm `lint:additive` passes
  (CI runs it as its own step, `.github/workflows/ci.yml:49`).

Web:

- **`packages/web/src/features/git-diff/push-readiness.test.ts`** (new) — a pure table
  test over `derivePushReadiness`: `undefined` remotes → `"unknown"`; `[]` → `"no-remote"`;
  `"(detached)"` branch → `"detached"` (checked *before* remotes, so a detached HEAD with
  no remote reports `"detached"`); current branch without `upstream` → `"no-upstream"`;
  everything present → `"ready"`. Also assert `PUSH_READINESS_COPY` contains no banned
  internal vocabulary — `lib/__tests__/copy.test.ts` already enforces that list; extend
  its input set rather than duplicating the rule.
- **`packages/web/src/features/git-diff/git-toolbar-state.test.ts`** (extend) —
  `resolveSetRemoteSubmit`: blank URL → `null`; whitespace trimmed; blank name omitted
  from the object entirely (not `name: ""`).
- **`packages/web/src/features/git-diff/components/GitStatusError.test.tsx`** (extend) —
  using the existing `fakePanel()` helper: markup contains "Set up git here" when
  `statusErrorCode === "workspace-not-a-repo"`; does **not** when it is
  `"workspace-missing"`; shows `existingRoot` when
  `initRepoResult = {state:"inside-existing-repo", existingRoot:"/repo"}`; the remove
  affordance renders as a `<button>` with the consequence in its label, not a
  `<Button variant="outline">`.
- **`packages/web/src/features/git-diff/components/GitToolbar.test.tsx`** (extend) —
  `renderToStaticMarkup` with `pushReadiness: "no-remote"` produces a `disabled` Push
  button and the "Add a remote" affordance; `"ready"` produces neither.
- **`packages/web/src/features/git-diff/__tests__/live-actions.test.ts`** (extend) —
  the file's existing fake-`rpc` recorder: `initRepo` calls `"git.init"` with
  `{idempotencyKey, worktree}`; `listRemotes` calls `"git.remotes"` and unwraps
  `.remotes`; `setRemote` forwards `url`/`name` and omits `name` when not given.
- **`packages/web/src/features/git-diff/use-git-panel.test.ts`** (extend) — using the
  existing `renderPanel` harness + `vi.spyOn(queryClient, "invalidateQueries")`: a
  successful `initRepo` invalidates `git-status`/`git-diff`/`git-branches`/`git-remotes`;
  an `"inside-existing-repo"` result invalidates **nothing**.
- **`packages/web/src/features/git-diff/__tests__/mock-source.test.ts`** (extend) — the
  three new mock methods behave (mock `initRepo` flips the mock's own repo flag so a
  follow-up `fetchStatus` succeeds, matching how `mock-source.ts`'s `createDirectory`
  already mutates its in-memory tree).

### 1.7 Rollout / risk notes

- **No env flag.** The `FALCON_PTY_SETMODE`/`FALCON_PTY_SETMODEL` precedent
  (`packages/cli/src/commands/start.ts:216,227`) exists for *version-coupled, keystroke-
  driven TUI behaviour that cannot be verified deterministically*. `git init` and
  `git remote add` are ordinary argv `execFile` calls with deterministic exit codes,
  fully covered by unit tests, gated on the same authorizer as three already-shipped
  mutating RPCs, and only reachable from an explicit user click. A flag here would be
  cargo-culting the precedent, and would also mean shipping a button that silently does
  nothing on machines that haven't set it.
- **Version skew is the real risk, and it is self-limiting.** A web build that knows
  `git.init` talking to an older daemon gets `{ok:false, error:"unknown-method"}`
  (`machineRpc.ts:871-875`) surfaced as `MachineRpcError`. Acceptable, but the copy
  should not read like a bug. Suggested: `use-git-panel.ts`'s `initRepoError` mapping
  special-cases the literal `"unknown-method"` into *"This machine is running an older
  version of Falcon — update it there and try again."* (`inline-spawn.ts`'s
  `translateSpawnError` is the existing precedent for message translation.)
- **`git init` is not reversible from the UI** — there is deliberately no "undo" RPC.
  It is close to harmless (an empty `.git` with no commits), but the button copy should
  not imply it can be taken back.
- **Open question 1:** should `git.init` optionally make an initial commit? Argument for:
  `git.diff` against an unborn HEAD produces confusing output, and `git status` shows
  every file as untracked. Argument against: an auto-commit is a real, opinionated write
  the user didn't ask for. **Recommendation: no** for this phase; revisit if the empty-repo
  panel turns out to be confusing in practice.
- **Open question 2:** should `git.init` also write a `.gitignore`? Same answer, same
  reason, and it would need language/framework detection this repo has nowhere to put.
- **Open question 3:** the `no-upstream` → automatic `setUpstream: true` behaviour changes
  what the plain Push button does today (it currently calls `panel.push({})`,
  `GitToolbar.tsx:150`). It is strictly more likely to succeed, but it does silently create
  a remote branch. Worth confirming with a human before shipping; the alternative is to
  keep `no-upstream` purely informational and add a separate "Publish branch" button.

---

## Feature 2 — Web UI when the daemon is offline/crashed

### 2.1 Problem

**(a) A click against an offline machine hangs for ~17 seconds, then fails opaquely.**
`packages/server/src/app/socket/rpcHandler.ts:230-240`:

```ts
      const room = rpcRoom(accountId, target);
      let targets = await fetchRoomSockets(io, room, RPC_LOOKUP_FETCH_TIMEOUTS_MS[0]!);
      if (targets.length === 0) {
        targets = await waitForRoomMember(io, room, RPC_RECONNECT_GRACE_MS, method);
      }

      if (targets.length === 0) {
        finish("not_available");
        callback?.({ ok: false, error: "RPC target not available" });
        return;
      }
```

with `RPC_LOOKUP_FETCH_TIMEOUTS_MS = [2_000, 4_000, 8_000]` (`:35`) and
`RPC_RECONNECT_GRACE_MS = 15_000` (`:45`). That grace window is *correct* — it exists so a
daemon mid-reconnect doesn't fail a legitimate call — but the web currently pays it on
every doomed click.

**(b) The presence signal exists, is already parsed, and no machine-RPC surface reads it.**
`machine-presence` is defined at `packages/wire/src/updates.ts:94-105`, emitted by the
server on machine-socket connect (`packages/server/src/app/socket.ts:150-159`) and
disconnect (`:270-287`, with the AH8 `needsReauth` inference), parsed in
`packages/web/src/sync/apiSocket.ts:312-319`, and turned into a
`Map<string, MachinePresence>` by
`packages/web/src/features/session-list/use-machine-presence.ts:35-61`.

Consumers today: `features/session-list/live-source.ts:261,265,316`,
`features/unmanaged-sessions/live-source.ts:181,186,214`, and
`components/timeline/SessionTimelineScreen.tsx:107-109` — which already computes exactly
the value this feature needs:

```ts
  const machinePresence = useMachinePresence();
  const machineRow = useSyncSnapshotQuery().data?.machines.find((m) => m.id === machineId);
  const machineOnline = machineRow ? deriveMachineOnline(machineRow, machinePresence, Date.now()) : false;
```

…and then threads it as a prop only as far as `SessionActionsMenu` (`:273-274`) and the
Restart gate (`lib/use-restart-session.ts:30,43`, which already owns the copy
*"This session's machine is offline"*). **No file under `features/git-diff`,
`features/repo-files`, `features/run-panel`, `features/preview`, `features/github-checks`
or `features/session-control` imports any presence symbol.** Every one of those panels
fires machine RPCs blind.

**(c) The only existing pre-flight gate is the crypto one.** All five
`useLive*Actions` hooks are structurally identical (`use-live-git-diff-actions.ts:35-44`
and its four siblings) and fall back to a `pending*Actions()` object whose every method
rejects with `"Machine key isn't unwrapped yet — try again in a moment."` There is a
ready-made seam here — it just has one condition today.

**⚠ Brief correction (see §0.2 #2, #3, #4):** there is no 90s server sweep; the window is
~17s not ~10s; and the composer is a *session* RPC, so "machine offline" is a related but
distinct signal from "this session can accept a message".

### 2.2 UX decision recap

- **(a) One shared hook**, `useMachineOnline(machineId)`, in `packages/web/src/lib/`
  (not under `features/session-list/`) — the same reasoning `use-machine-crypto.ts:17-23`
  gives for living in `lib/`: once a second feature area needs it, there should be exactly
  one place that owns it. It reuses `useMachinePresence` + the `['sync']` snapshot; no new
  store, no new subscription mechanism.
- **(b) Narrow scope, no blocking overlay.** Already-synced data keeps working fully:
  the transcript (`sync/reducer.ts` output from the `['sync']` + `['messages', id]`
  caches), the session list, the workspace nav, Settings — none of it changes. Only
  genuinely machine-live *actions* gate. Cached panel data stays on screen with a small
  "Machine is offline" chip above it; it does not blank out. This is the same call
  `session-list/status.ts:141` already makes (`machineOnline === false` → `"offline"`,
  while `null` — unknown — deliberately does not).
- **(c) Self-healing.** `useMachinePresence` updates its map from the live ephemeral, so a
  machine coming back flips every consumer on the next render with no refresh, satisfying
  CLAUDE.md rule #6. The panels additionally re-fetch on that transition (see the
  `useEffect` in §2.4) so stale cached data catches up too.
- **(d) The composer is handled separately and honestly.** The right primary signal there
  is the session's own status (`isSessionControlDisabled`,
  `SessionTimelineScreen.tsx:364-366`). Machine-offline is added as a *second*,
  clearly-worded reason — *"This session's machine is offline — your message will send when
  it's back"* is **not** what we ship, because we do not queue. We ship: composer stays
  enabled, but a non-blocking notice appears (reusing `ComposerState.notice`, already
  built for `outcome-unknown` at `use-composer-state.ts:39-42`), and a failed send shows
  "That machine is offline right now" instead of `"RPC target not available"`. Rationale:
  the machine-presence map starts empty for a fresh tab (`use-machine-presence.ts:20-22`),
  so hard-disabling the composer on a not-yet-known machine would block a working session.
  Rule #7 — do not claim a property we have not verified.

### 2.3 Wire protocol changes

**None.** `EphemeralSchema`'s `machine-presence` member already carries everything needed.

### 2.4 Web changes

#### New file: `packages/web/src/lib/use-machine-online.ts`

```tsx
"use client";

import {
  deriveMachineOnline,
  deriveMachineStatus,
  type MachineStatus,
  useMachinePresence,
} from "@/features/session-list";
import { useSyncSnapshotQuery } from "./use-sync-snapshot";

/**
 * One machine's live online/offline/needs-reauth state, for any feature that
 * is about to make a machine RPC (`sync/machineRpc.ts` — `git.*`, `fs.*`,
 * `run.*`, `preview.*`, `github.checks`, `spawn`).
 *
 * Lives in `lib/` rather than under `features/session-list/` for the same
 * reason `use-machine-crypto.ts` does: six feature areas need it, so exactly
 * one module should own it. It adds no new state — it composes the existing
 * `useMachinePresence` ephemeral subscription with the `['sync']` snapshot's
 * `MachineRow`, exactly as `features/session-list/live-source.ts:254-266` and
 * `components/timeline/SessionTimelineScreen.tsx:107-109` already do
 * inline. Those two call sites should be refactored onto this hook so there
 * is one derivation, not three.
 *
 * WHY THIS MATTERS AT ALL (the honest version): the server's RPC relay waits
 * out a reconnect grace window before failing a call to a target that isn't
 * in its room — `RPC_RECONNECT_GRACE_MS = 15_000` plus a 2s initial lookup
 * (`packages/server/src/app/socket/rpcHandler.ts:35,45,230-240`). So a click
 * against a powered-off machine takes roughly 17 seconds to surface "RPC
 * target not available". That grace window is deliberate and should NOT be
 * shortened — it is what makes a daemon reconnect invisible. This hook is the
 * client-side answer instead: don't make the call.
 *
 * ⚠ `"unknown"` is a real, common state, not an edge case. `machine-presence`
 * is only emitted on a machine socket's own connect/disconnect
 * (`packages/server/src/app/socket.ts:150-159`, `:270-287`) — there is no
 * periodic sweep and no retroactive snapshot for a web client that connects
 * later. `deriveMachineOnline` therefore falls back to the `lastSeenAt`
 * recency heuristic (`MACHINE_ONLINE_WINDOW_MS`, 3 minutes, fed by the
 * daemon's 60s `machine-alive` heartbeat via `socket.ts:242-254`). Callers
 * must treat `"unknown"` as "go ahead and try", never as offline: blocking on
 * a machine we simply haven't heard about yet would break a working session.
 */
export type MachineAvailability = "online" | "offline" | "needs-reauth" | "unknown";

export interface MachineOnlineState {
  availability: MachineAvailability;
  /** `true` only for a confidently-offline or needs-reauth machine — the single boolean a caller should gate a button on. `false` for `"unknown"`. */
  isKnownUnavailable: boolean;
  /** Plain-language reason, or `null` when there's nothing to say. No internal vocabulary (CLAUDE.md auth/UX rule #4). */
  reason: string | null;
}

const UNAVAILABLE_COPY: Record<Exclude<MachineStatus, "online">, string> = {
  offline: "This project's machine is offline right now.",
  "needs-reauth": "This project's machine needs to sign in again. Run `falcon auth login` there.",
};

export function useMachineOnline(machineId: string | null | undefined): MachineOnlineState {
  const presence = useMachinePresence();
  const snapshot = useSyncSnapshotQuery();
  const machine = machineId ? snapshot.data?.machines.find((m) => m.id === machineId) : undefined;

  if (!machine) {
    // The row hasn't synced yet (or there is no machine for this session) —
    // "unknown", never "offline". Same rule as `session-list/status.ts:141`,
    // where `machineOnline === null` deliberately does not produce "offline".
    return { availability: "unknown", isKnownUnavailable: false, reason: null };
  }

  const status = deriveMachineStatus(machine, presence, Date.now());
  // `deriveMachineStatus` already prefers a live event over the heuristic
  // (use-machine-presence.ts:103-115); calling `deriveMachineOnline` too would
  // just re-derive the same thing, so this maps the richer value directly.
  if (status === "online") {
    return { availability: "online", isKnownUnavailable: false, reason: null };
  }
  return {
    availability: status,
    isKnownUnavailable: true,
    reason: UNAVAILABLE_COPY[status],
  };
}
```

> `deriveMachineOnline` is imported above only to keep the refactor of the two existing
> inline call sites in mind; if the final implementation doesn't use it, drop the import.
> The `now` argument is `Date.now()` at render time, matching
> `live-source.ts`'s own usage — the heuristic is coarse (3 minutes) so there is no need
> for a ticking clock, and the live ephemeral is what actually drives updates.

#### New file: `packages/web/src/components/machine-offline-notice.tsx`

```tsx
"use client";

import { CloudOff } from "lucide-react";
import type { MachineOnlineState } from "@/lib/use-machine-online";

/**
 * The one shared "this machine can't be reached right now" strip every
 * machine-RPC panel renders (Changes, All Files, Checks, Run, Preview).
 * Deliberately a slim inline strip, NOT a full-screen or blocking overlay:
 * everything already fetched stays readable and scrollable underneath, and
 * everything sourced from the synced caches (the transcript, the session
 * list) is unaffected by a machine being offline at all.
 *
 * Renders nothing when the machine is online or its state is unknown — see
 * `useMachineOnline`'s doc comment on why "unknown" must never look like
 * "offline".
 */
export function MachineOfflineNotice({ state }: { state: MachineOnlineState }) {
  if (!state.isKnownUnavailable || state.reason === null) return null;
  return (
    <div
      className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <CloudOff className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{state.reason}</span>
    </div>
  );
}
```

#### Panel wiring (the repeating pattern)

Each of the five panels takes the same three-line change. `GitDiffPanel.tsx` shown; the
same applies to `RepoFilesPanel.tsx`, `RunPanel.tsx`, `PreviewPanel.tsx`, `ChecksPanel.tsx`,
and to `SessionSidePanel.tsx`'s `ChangesTab`/`AllFilesTab`.

```tsx
export function GitDiffPanel({ machineId, worktree, useActions = useLiveGitDiffActions }) {
  const actions = useActions(machineId);
  const panel = useGitPanel(actions, worktree);
  const machine = useMachineOnline(machineId);
  // ...
  return (
    <div className="flex h-full flex-col gap-3">
      <MachineOfflineNotice state={machine} />
      <GitToolbar panel={panel} machineUnavailable={machine.isKnownUnavailable} />
      {/* ... */}
```

`GitToolbar` (and `RunPanel`'s play/stop, `PreviewPanel`'s open/close, `ChecksPanel`'s
refresh) `||`s `machineUnavailable` into the existing `disabled` expressions — e.g.
`GitToolbar.tsx:71-72`'s `gitOperationPending` becomes
`gitOperationPending || machineUnavailable`. No new disabled-state machinery.

#### Self-healing re-fetch

Add to `use-git-panel.ts` (and the equivalent in `use-repo-files.ts`, `use-run-panel.ts`,
`use-preview-panel.ts`, `use-checks-panel.ts`), keeping the `machineOnline` boolean as an
explicit argument so the hooks stay testable without mocking a socket:

```ts
  // A machine coming back online must repair the panel by itself (CLAUDE.md
  // rule #6 — "every waiting screen updates itself"): any query that failed
  // while it was offline is now stale-and-wrong, and nothing else would
  // retry it. Keyed on the false→true transition only, so a machine that was
  // online all along never triggers an extra fetch on mount.
  const wasOffline = useRef(false);
  useEffect(() => {
    if (!machineOnline) {
      wasOffline.current = true;
      return;
    }
    if (!wasOffline.current) return;
    wasOffline.current = false;
    invalidateStatusAndDiff();
    void queryClient.invalidateQueries({ queryKey: ["git-branches", worktree] });
  }, [machineOnline, worktree, queryClient]);
```

#### Composer path

1. `features/session-control/session-control-context.tsx` — extend the context value with
   `machineId: string | null` and `machineOnline: boolean`. `SessionTimelineScreen.tsx`
   already computes both one component above the provider (`:101`, `:109`), so this is a
   prop pass, not a new derivation.
2. `features/session-control/use-composer-state.ts` — do **not** block `send`. Instead:
   - when the machine is known-unavailable, set `notice` (the existing non-blocking field,
     `:39-42`) to *"That machine is offline right now — the message may not go through."*
     before the mutation fires;
   - in the mutation's error path (`:86-89`), translate the two transport strings the relay
     can produce — `"RPC target not available"` and `"RPC target disconnected"`
     (`rpcHandler.ts:238`, `:283`) — into *"That machine is offline right now."* This
     mapping is a small pure function, `translateSendError(raw, machineOffline)`, placed in
     `optimistic-composer.ts` next to the existing `deliveryNotice` helper so it is
     directly unit-testable.
3. `components/timeline/Composer.tsx` — no change. Its `disabled` prop stays driven purely
   by `isSessionControlDisabled(sessionStatus)`.

#### Spawn path

`features/session-list/components/new-session-panel.tsx:345` — `canStart` already requires
a machine to be picked (`:234`). Add `&& !machineUnavailable`, and render
`MachineOfflineNotice` above the Start button. This one **is** safe to hard-disable: the
panel already renders an online dot per machine in its picker (`:256-261`), so the
disabled state is legible rather than mysterious.

### 2.5 Testing plan

- **`packages/web/src/lib/use-machine-online.test.ts`** (new) — using
  `use-git-panel.test.ts`'s one-shot `renderToStaticMarkup` harness plus a
  `QueryClientProvider` seeded via `queryClient.setQueryData(["sync"], {...})` and an
  in-memory `EphemeralSource` double (the exact double
  `use-machine-presence.test.ts` already builds):
  - no machine row → `{availability:"unknown", isKnownUnavailable:false, reason:null}`;
  - a row with `lastSeenAt` 10s ago and no live event → `"online"`;
  - a row with `lastSeenAt` 10 minutes ago → `"offline"` with copy;
  - a row with `needsReauth: true` → `"needs-reauth"` with its own distinct copy (never
    collapsed into "offline", matching `machine-badge.tsx`'s AH8 rule);
  - `machineId: null` → `"unknown"`.
  Because there is no jsdom, the live-event-flips-it case is covered at the
  `deriveMachineStatus` level (already tested in `use-machine-presence.test.ts`) rather
  than by re-rendering — note this limitation in the test file's own header comment, the
  way `use-git-panel.test.ts:8-22` does.
- **`packages/web/src/components/machine-offline-notice.test.tsx`** (new) —
  `renderToStaticMarkup`: renders nothing for `online`/`unknown`; renders the reason and
  `role="status"` for `offline`; renders the distinct needs-reauth copy.
- **`packages/web/src/features/session-control/__tests__/optimistic-composer.test.ts`**
  (extend) — `translateSendError("RPC target not available", true)` and
  `("RPC target disconnected", true)` both produce the offline copy; an unrelated message
  passes through unchanged; with `machineOffline: false` the relay strings still translate
  (the relay is authoritative about reachability even when presence says otherwise).
- **`packages/web/src/features/git-diff/components/GitToolbar.test.tsx`** (extend) —
  `machineUnavailable: true` disables Commit / Commit&Push / Push / Force Push.
- **`packages/web/src/features/session-list/components/new-session-panel.test.tsx`**
  (extend) — the existing `defaultOpen` escape hatch (`:62-64`) renders the dialog;
  assert Start is `disabled` when the target machine is offline.
- **No daemon or server tests.** Nothing changes on either side.

### 2.6 Rollout / risk notes

- **No env flag.** Purely additive web behaviour with an explicit "unknown → allow"
  default; the failure mode of a bug here is a spurious grey chip, not a broken action.
- **The real risk is a false "offline".** Two sources: (1) a fresh tab whose presence map
  is empty *and* whose `lastSeenAt` is stale even though the daemon is up — possible if
  the daemon's `machine-alive` heartbeat write failed silently
  (`socket.ts:248-254` logs and swallows); (2) clock skew between the browser and the
  server's `lastSeenAt` timestamps, since the 3-minute window compares a server-stamped
  `Date` against browser `Date.now()`. Mitigation: never render a *blocking* state, always
  leave a way through. The panels are disabled-but-visible, and the composer is not
  blocked at all. **Do not** add a hard block anywhere without first fixing the clock-skew
  question.
- **Refactor debt worth paying in the same PR:** move
  `SessionTimelineScreen.tsx:107-109` and `live-source.ts:254-266` onto `useMachineOnline`
  so there is one derivation. Leaving three is how the `isMachineOnline`/
  `isMachineOnlineHeuristic` duplication happened the first time
  (`use-machine-presence.ts:63-67` still documents that history).
- **Open question:** should `use-workspace-nav.ts:11` keep passing `EMPTY_PRESENCE`? It
  does so deliberately today (the sidebar nav uses `lastSeenAt` only), but the reasoning
  isn't recorded in the file. Worth confirming with whoever wrote it before "fixing" it.
- **Explicitly out of scope:** shortening `RPC_RECONNECT_GRACE_MS`. It is what makes a
  daemon reconnect invisible to a legitimate call; the client-side gate is the right fix.

---

## Feature 3 — File tree / diff / file viewer: adopt libraries, stop hand-rolling

### 3.1 Problem

**(a) `FileViewer` has an infinite re-highlight loop. This is almost certainly the
reported "freeze".** `packages/web/src/features/repo-files/components/FileViewer.tsx:9-29`:

```ts
function useFileTokens(path: string, content: string): ThemedToken[][] {
  const lines = content.split("\n");                       // ← new array EVERY render
  const [tokens, setTokens] = useState<ThemedToken[][]>(...);

  useEffect(() => {
    let cancelled = false;
    const lang = languageForPath(path);
    highlightDiffLines(lines, lang).then((result) => {
      if (!cancelled) setTokens(result);                   // ← triggers a render
    });
    return () => { cancelled = true; };
  }, [path, lines]);                                       // ← `lines` identity changes

  return tokens;
}
```

`lines` is rebuilt on every render, so the effect's dependency array never compares equal.
`setTokens` re-renders the *same* component that owns the effect, which rebuilds `lines`,
which re-runs the effect, which calls `highlightDiffLines` again. `highlightDiffLines`
(`packages/web/src/lib/diffHighlight.ts:81-101`) is a full `shiki` `codeToTokens` pass over
the entire file body on the main thread. The loop is bounded only by how fast shiki can
tokenize — i.e. it pegs a core for as long as the file is open. Bigger file, worse loop.

`UnifiedDiffViewer.tsx:11-39` has the same `useFileTokens` shape but depends on `[file]`,
and `setTokensByHunk` lives in the child `FileDiff` — so the parent's `file` prop identity
is stable between parent renders and it does **not** self-loop. It does still re-parse
(`parseUnifiedDiff` at `UnifiedDiffViewer.tsx:124`, called in the render body) and
re-tokenize the entire diff on every parent render.

**(b) Nothing virtualizes — including the Timeline, contrary to `docs/packages-guide.md`.**
- `components/timeline/Timeline.tsx:81` renders `<RenderItemGroups items={visibleItems} />`
  for every item, with only a manual "Load earlier" button (`:68-80`). There is no
  windowing anywhere in the file. **`docs/packages-guide.md`'s claim that the timeline is
  "virtualized" is wrong** — this plan is the second independent confirmation.
- `FileViewer.tsx:81-84` maps every line of the file to its own `<FileLineRow>` — three
  `<span>`s plus one `<span>` per shiki token, so a 5,000-line file is on the order of
  10⁵ DOM nodes.
- `UnifiedDiffViewer.tsx:96-103` maps every hunk line the same way.
- `FileTree.tsx:11-85` is a recursive `<TreeNode>` that renders every expanded node with
  no windowing. `buildFileTree` (`file-tree-logic.ts:15-54`) is O(n·m) on a flat
  `git.files` list — a `level.find(...)` linear scan per path segment — and is called
  **unmemoized** in `use-repo-files.ts:50` (`const tree = filesQuery.data ? buildFileTree(filesQuery.data) : []`),
  so the whole tree is rebuilt on every render of the hook, and every node identity
  changes, defeating React reconciliation for the entire subtree.

**(c) `truncated` is surfaced, but as a dead-end warning.**
`FsReadResultSchema`/`GitDiffResultSchema` both carry `truncated: z.boolean()`
(`packages/wire/src/rpc.ts:473-478`, `:154-159`), set by `fsRead.ts:139-151` and
`gitDiff.ts:113` at a 60,000-byte budget (`MAX_INLINE_BYTES` in both). The web renders an
amber strip — `FileViewer.tsx:71-75` ("This file was truncated…") and
`UnifiedDiffViewer.tsx:132-137` — with **no way to see the rest**. Meanwhile
`FsReadParamsSchema.range` (`rpc.ts:464-469`) already supports byte-offset paging and
`fsRead.ts:130-137` already implements it, and `FsReadResult.blobRef` is populated when a
blob uploader is wired (`fsRead.ts:146-149`). None of that is reachable from the UI —
`live-actions.ts:23-30` never sends `range`.

**(d) Two independent tokenizer instances per open file.** `FileViewerColumn.tsx:44-45`
deliberately calls `useLiveRepoFilesActions`/`useLiveGitDiffActions` again rather than
sharing the sidebar's (documented at `:22-31`). The network call dedupes via the shared
query key, but the *tokenization* does not — while a file is open in the main column, the
loop in (a) is running there.

### 3.2 UX decision recap

Adopt three libraries; delete the corresponding hand-rolled code.

| Need | Library | Why |
|---|---|---|
| Windowing primitive | **`@tanstack/react-virtual`** | Headless, ~5KB gzipped, no styling opinions, and the same maintainers/mental model as the already-pervasive `@tanstack/react-query` (`packages/web/package.json:27`). Works for all three surfaces: timeline, file lines, diff lines. MIT. |
| File tree | **`react-arborist`** | Purpose-built virtualized tree: windowing, keyboard nav, and selection out of the box. Replaces `FileTree.tsx` + the hot path of `file-tree-logic.ts`. MIT. |
| Diff renderer | **`@git-diff-view/react`** | See below. MIT. |

**Diff library choice — `@git-diff-view/react` over `react-diff-viewer-continued`.**

- `@git-diff-view/react` consumes **raw unified-diff text**, which is exactly what
  `GitDiffResult.inline` is. `react-diff-viewer-continued` wants the **old and new full
  file contents** and diffs them itself — Falcon does not have those, and obtaining them
  would mean two extra `fs.read` calls per file plus a client-side diff, on data the
  daemon already diffed correctly.
- It handles split/unified toggle, renames and binary files natively. Falcon's own
  `lib/unifiedDiff.ts:31-42` already models `binary` and `oldPath`/`newPath` but
  `UnifiedDiffViewer.tsx:87-89` only renders "Binary file — no diff to show." and never
  special-cases renames (its own doc comment at `lib/unifiedDiff.ts:8-12` admits this).
- It virtualizes long diffs internally; `react-diff-viewer-continued` does not.
- **Cost, stated honestly:** it is a smaller/younger project than
  `react-diff-viewer-continued`, and it ships its own theming that will need CSS-variable
  mapping onto this app's Tailwind tokens. Its highlighting integrates with `shiki`
  — already a dependency (`package.json:51`) — so no second tokenizer enters the bundle.
- **If it does not work out**, the fallback is *not* `react-diff-viewer-continued`; it is
  keeping `lib/unifiedDiff.ts` (which is good, well-tested code) and virtualizing its
  output with `@tanstack/react-virtual` — i.e. Phase 1 below is already the fallback,
  which is why the phasing is ordered the way it is.

**Already-installed alternatives, checked before proposing anything new:**
- `shiki` (`:51`) — the tokenizer. Kept; the fix is *where* and *how much* it runs, not
  replacing it.
- `streamdown` / `@streamdown/code` (`:23-26`, `:54`) and `ai` / ai-elements (`:29`) —
  markdown/chat rendering. `components/ai-elements/conversation` provides `Conversation`,
  `ConversationContent`, `ConversationScrollButton` (used by `Timeline.tsx:4-9`) and
  `use-stick-to-bottom` (`:58`) provides the follow-the-bottom behaviour. **None of them
  virtualize**, and `use-stick-to-bottom` is specifically the thing virtualization has to
  cooperate with, not a substitute for it. This is the single riskiest interaction in the
  feature — see the phasing.
- `@xyflow/react` (`:28`) virtualizes a graph canvas; irrelevant here.
- `rehype-pretty-code` (`:45`) wraps shiki for markdown; not applicable to raw diffs.

**Phasing (deliberately ordered so each phase ships value alone):**

- **Phase 1 — correctness, no new dependencies.** Fix the `FileViewer` loop; memoize
  `buildFileTree`; memoize `parseUnifiedDiff`. This alone should resolve the reported
  freeze and is safe to ship on its own.
- **Phase 2 — highlighting off the main thread.** A shiki web worker, or (cheaper)
  viewport-only highlighting. This repo already builds a worker bundle
  (`packages/web/scripts/build-worker.mjs`, run by both `build` and `dev` in
  `package.json:8-9`) so the pattern exists.
- **Phase 3 — virtualization.** `@tanstack/react-virtual` for file lines and diff lines
  (leaf-level, low risk), then the file tree via `react-arborist`, then the Timeline
  **last** because of the `use-stick-to-bottom` interaction.
- **Phase 4 — `@git-diff-view/react`** replaces `UnifiedDiffViewer`.
- **Phase 5 — the `truncated` UX moment.**

### 3.3 Wire protocol changes

**None.** `FsReadParams.range` (`rpc.ts:464-469`) and both `truncated` flags already exist
and are already implemented daemon-side. Phase 5 is purely about *calling* them.

### 3.4 Daemon changes

**None required.** One optional note: `fsRead.ts:143-144` appends a human-readable marker
into the truncated text itself —

```ts
  const text = `${slice.toString("utf8")}\n\n… (file truncated at ${maxInlineBytes} bytes)\n`;
```

— which becomes real content in the viewer and will show up as the last two "lines" of the
file. Once the web renders a proper truncation affordance (Phase 5), that marker is
redundant and mildly wrong (it inflates the line count). Removing it would be a **behaviour
change visible to any older web client**, so it should either stay, or be removed only
after the new viewer ships. Recommendation: leave it; strip it client-side in the new
viewer with an explicit comment saying why.

### 3.5 Web changes

#### Phase 1a — fix the `FileViewer` loop (`components/FileViewer.tsx`)

```tsx
/**
 * Highlights every line of `content` in one `highlightDiffLines` call.
 *
 * ⚠ The dependency list is `[path, content]` — the raw string — NOT the split
 * `lines` array. `content.split("\n")` produces a new array identity on every
 * render, and `setTokens` re-renders THIS component, so depending on the array
 * made the effect re-run forever: highlight → setState → render → new array →
 * highlight. `highlightDiffLines` is a full shiki `codeToTokens` pass over the
 * whole file on the main thread, so that loop pegged a core for as long as the
 * file stayed open (this is the "switching files freezes the UI" report).
 * `lines` is derived inside the effect and memoized for render use.
 */
function useFileTokens(path: string, content: string): ThemedToken[][] {
  const lines = useMemo(() => content.split("\n"), [content]);
  const [tokens, setTokens] = useState<ThemedToken[][]>(() =>
    lines.map((line) => [{ content: line } as ThemedToken]),
  );

  useEffect(() => {
    let cancelled = false;
    const lang = languageForPath(path);
    // Reset to unhighlighted text for the NEW content immediately, so a slow
    // highlight of a big file never leaves the previous file's tokens zipped
    // against this file's lines (a real mis-render, not just a flash).
    setTokens(content.split("\n").map((line) => [{ content: line } as ThemedToken]));
    highlightDiffLines(content.split("\n"), lang).then((result) => {
      if (!cancelled) setTokens(result);
    });
    return () => {
      cancelled = true;
    };
  }, [path, content]);

  return tokens;
}
```

The mid-flight reset also fixes a second latent bug: today, switching from a 200-line file
to a 5,000-line file renders 5,000 rows zipped against 200 stale token arrays until the new
highlight resolves (`FileViewer.tsx:83` — `tokens[i] ?? []`).

#### Phase 1b — memoize the two other hot paths

`use-repo-files.ts:50`:

```ts
  // `buildFileTree` is O(n·m) over the flat `git.files` list (a linear
  // `level.find` per path segment) and returns a brand-new node object for
  // every path. Calling it in the render body rebuilt the whole tree on every
  // render AND changed every node's identity, so React reconciled the entire
  // subtree each time and `FileTree`'s expanded-set state was the only thing
  // holding the view together.
  const tree = useMemo(() => (filesQuery.data ? buildFileTree(filesQuery.data) : []), [filesQuery.data]);
```

`UnifiedDiffViewer.tsx:124` — move `parseUnifiedDiff` behind `useMemo(..., [diff.inline])`.
Note this requires restructuring the early returns at `:120-128`, since hooks cannot sit
below a conditional return; extract the empty-state checks into the parent or compute the
parse first and branch on its result.

#### Phase 2 — highlighting off the main thread

Preferred: a `shiki` worker at `packages/web/src/workers/highlight.worker.ts`, bundled by
the existing `scripts/build-worker.mjs` pipeline, with `lib/diffHighlight.ts` keeping its
exact current signature (`highlightDiffLines(lines, lang): Promise<ThemedToken[][]>`) and
posting to the worker instead of calling `codeToTokens` inline. Because the signature is
unchanged, **both** viewers get the fix with no call-site edits, and
`diffHighlight.ts:69-72`'s `plainTokens` fallback already defines the correct degraded
behaviour if the worker fails to start.

Cheaper interim: only tokenize the visible window (natural once Phase 3 lands — the
virtualizer already knows the visible range).

#### Phase 3 — virtualization

```bash
pnpm --filter @falcon/web add @tanstack/react-virtual react-arborist
```

New shared component `packages/web/src/components/virtual-line-list.tsx`:

```tsx
"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useRef } from "react";

/**
 * The house windowing primitive for long, fixed-row-height lists — the
 * file viewer's lines and the diff viewer's hunk lines today, and any future
 * list of the same shape.
 *
 * `@tanstack/react-virtual` (not a hand-rolled windowing pass) for the same
 * reason `@tanstack/react-query` owns caching here: it is headless, it has no
 * styling opinions to fight with Tailwind, and one well-tested primitive beats
 * three near-identical hand-rolled ones. Rows are a FIXED height on purpose —
 * every consumer renders `font-mono text-xs leading-5` (20px), so
 * `estimateSize` is exact and no dynamic measurement is needed.
 *
 * ⚠ Fixed-height rows mean lines must NOT wrap. Today's rows use
 * `whitespace-pre-wrap break-all` (`FileViewer.tsx`/`UnifiedDiffViewer.tsx`),
 * so a long line wraps to several visual lines. Consumers of this component
 * must switch to `whitespace-pre` + horizontal scroll — a real, visible
 * behaviour change that has to be accepted, not smuggled in. (Dynamic
 * measurement via `measureElement` is possible but costs a layout pass per
 * row, which is exactly the cost this exists to avoid.)
 */
export function VirtualLineList({
  count,
  rowHeight = 20,
  overscan = 24,
  renderRow,
  className,
}: {
  count: number;
  rowHeight?: number;
  overscan?: number;
  renderRow: (index: number) => ReactNode;
  className?: string;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  return (
    <div ref={parentRef} className={className} style={{ overflow: "auto" }}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: `${item.size}px`,
              transform: `translateY(${item.start}px)`,
            }}
          >
            {renderRow(item.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
```

`FileViewer` then becomes `<VirtualLineList count={lines.length} renderRow={(i) => <FileLineRow lineNumber={i+1} tokens={tokens[i] ?? []} />} />`,
with `FileLineRow` unchanged except `whitespace-pre-wrap break-all` → `whitespace-pre`.

`FileTree.tsx` is replaced by `react-arborist`'s `<Tree>`. `buildFileTree`'s output shape
(`FileTreeNode` with `name`/`path`/`isDirectory`/`children?`, `types.ts:34-40`) already
matches arborist's expected node shape, so **`file-tree-logic.ts` and its tests survive
unchanged** — only the renderer is replaced. The `expanded: Set<string>` state
(`FileTree.tsx:105-117`) moves into arborist's own controlled/uncontrolled state.

**Timeline last, and behind a flag** (see §3.7). `Timeline.tsx` renders heterogeneous,
variable-height items through `RenderItemGroups` and relies on `use-stick-to-bottom` via
`Conversation`/`ConversationScrollButton` (`Timeline.tsx:4-9,63-89`). Virtualizing it
means dynamic measurement (`measureElement`) *and* re-deriving the stick-to-bottom
behaviour on a virtualized scroll container. That is a materially larger and riskier change
than the other two surfaces and should be its own PR.

#### Phase 4 — `@git-diff-view/react`

```bash
pnpm --filter @falcon/web add @git-diff-view/react
```

`UnifiedDiffViewer.tsx` becomes a thin adapter: feed it `diff.inline`, map its theme onto
this app's CSS variables, keep the truncation strip. **Keep `lib/unifiedDiff.ts` and its
tests** — `ChangedFilesList`/other callers may parse independently, and it is the
documented fallback if the library disappoints.

#### Phase 5 — the truncation UX moment

Replace the two amber strips with a real affordance. `features/repo-files/types.ts`'s
`RepoFilesActions.fetchFileContent` gains an optional `range`:

```ts
  /** Fetches one file's content (`fs.read`), `path` relative to `worktree`. `range` is a byte-offset `[start, end)` slice — the daemon already implements it (`fsRead.ts`) and clamps it to its own inline budget, so a caller can page a large file instead of re-serving the same truncated prefix forever. Throws on failure. */
  fetchFileContent(
    worktree: string,
    path: string,
    range?: { start: number; end: number },
  ): Promise<RepoFileContent>;
```

`live-actions.ts` forwards it; `use-repo-files.ts` keeps a `loadedBytes` cursor and appends
each page. The strip becomes:

> **Large file** — showing the first 60 KB. **[Load more]**

For diffs, `git.diff` has no `range` parameter and adding one would be a wire change; the
honest affordance there is the one the current copy already hints at
(`UnifiedDiffViewer.tsx:135-136`, "Narrow it down to a single file") — turn that sentence
into an actual button that sets `selectedPath`. If per-file diffs still truncate, the real
answer is `blobRef` + the blob subsystem, which is a separate, larger piece of work
(`gitDiff.ts:28-37` describes the intended design) and is explicitly **not** in this plan.

### 3.6 Testing plan

The `environment: "node"` constraint bites hardest here: virtualization cannot be
meaningfully asserted without a DOM. Plan accordingly — test the pure parts, smoke-test the
markup, and be explicit about what is only verifiable by hand.

- **`packages/web/src/lib/diffHighlight.test.ts`** (new, if absent) — `languageForPath`
  mapping incl. the extensionless and unknown-extension fallbacks
  (`diffHighlight.ts:61-67`); `highlightDiffLines([], lang)` → `[]`;
  an invalid `lang` falls back to `plainTokens` with one token per line and the text
  intact (`:98-100`) — this is the guarantee the worker migration must preserve.
- **`packages/web/src/features/repo-files/__tests__/file-tree-logic.test.ts`** (existing) —
  unchanged. Add one case: `buildFileTree` returns a **referentially stable** result for
  the same input array, documenting the invariant `useMemo` now relies on.
- **`packages/web/src/features/repo-files/components/FileViewer.test.tsx`** (new) —
  `renderToStaticMarkup` smoke test: N lines produce N numbered rows (in the pre-virtual
  phases); `content.truncated` renders the truncation affordance; `content.inline`
  undefined renders "No content to show." The infinite-loop regression itself is **not**
  assertable here (it needs re-renders). Assert it instead at the pure level: extract the
  effect's dependency computation, or — better — leave a prominent comment in
  `useFileTokens` (as drafted above) explaining the hazard, and add a
  **manual verification step** to the PR: open a 3,000-line file, confirm CPU settles
  within a second, switch files twice, confirm it settles again.
- **`packages/web/src/components/virtual-line-list.test.tsx`** (new) — under
  `renderToStaticMarkup` the virtualizer reports a zero-height scroll element and renders
  ~zero rows, so assert only what is meaningful without layout: the wrapper's
  `getTotalSize()`-derived height equals `count * rowHeight`, and `renderRow` is never
  called with an out-of-range index. Say so in the file header, mirroring
  `use-git-panel.test.ts:8-22`'s precedent for documenting the constraint.
- **Truncation paging (`use-repo-files.test.ts`, new)** — the cursor/append logic must be a
  pure function (`appendPage(previous, page)`), tested directly: appending a page advances
  the cursor by the received byte length; a page with `truncated: false` clears the "load
  more" affordance; a page shorter than requested terminates.
- **Bundle-size guard.** Record before/after `next build` output sizes for the session
  route in the PR description. Three dependencies is the largest surface this plan adds;
  the number should be visible, not assumed.

### 3.7 Rollout / risk notes

- **Phase 1 ships alone and immediately.** It is a bug fix with no dependency change, no
  UX change, and it is the fix for the reported freeze. Do not hold it behind the rest.
- **Flag the Timeline virtualization, and only that.** This is where the
  `FALCON_PTY_SETMODE` precedent genuinely applies in spirit: a behaviour that is hard to
  verify deterministically (scroll position, stick-to-bottom, "Load earlier" interaction)
  and whose failure mode is a visibly broken primary surface. The CLI's env-var mechanism
  does not exist in a statically-exported PWA, so the web equivalent is a build-time
  `NEXT_PUBLIC_FALCON_VIRTUAL_TIMELINE` read once into a module constant, defaulting off,
  with `Timeline.tsx` keeping both code paths until it has soaked. File-line, diff-line and
  file-tree virtualization do **not** need this — their failure modes are visible in one
  glance and they have no scroll-anchoring contract.
- **`whitespace-pre-wrap` → `whitespace-pre` is a real UX regression for long lines** on
  mobile: today a long line wraps, after this it requires horizontal scrolling. This is the
  price of fixed-height rows. It should be an explicit product decision, not a side effect
  discovered in review. Alternative: dynamic measurement via `measureElement`, at the cost
  of a layout pass per row.
- **Three new dependencies is the real cost.** All three are MIT. `@tanstack/react-virtual`
  is small and low-risk. `react-arborist` and `@git-diff-view/react` are heavier and more
  opinionated; either could be dropped without abandoning the plan (the tree can use
  `VirtualLineList` over a flattened node array; the diff can keep `lib/unifiedDiff.ts` +
  `VirtualLineList`). If the reviewer wants a one-library outcome, that combination is a
  legitimate, smaller answer.
- **Fix `docs/packages-guide.md`** in the same PR — its "virtualized" timeline claim is
  false today and would still be false after Phase 1-2. That is the second doc-drift
  finding in this plan (see §0.2 #2 for the other).
- **Open question 1:** should the shiki worker be a *new* worker, or share the existing
  crypto worker bridge (`packages/web/src/crypto/`, `lib/use-crypto-bridge.ts`)? Sharing
  would let a long tokenization block key unwrapping — almost certainly the wrong trade,
  but the existing bundling script is set up for one worker and needs checking.
- **Open question 2:** `FileViewerColumn.tsx:22-31` deliberately mounts a *second*
  per-machine crypto worker while a file is open. Post-Phase-2 that is two shiki workers
  too. Worth revisiting that decision, but it is a separate refactor.

---

## Feature 4 — "New workspace" creation flow

### 4.1 Problem

**⚠ Brief correction (§0.2 #1): the web app cannot create a project at all today.**

`packages/web/src/features/session-list/session-list-screen.tsx:59-68` states it plainly:

> B5 (new-session-from-web redesign …): the old standalone "New session" wizard/route is
> retired — a session now always starts from the `+` on an existing `WorkspaceSection` row
> …, since a workspace only exists server-side once `falcon` has actually run there once.
> That leaves one genuine gap this screen still has to cover honestly: an account with
> machines but literally zero sessions ever run has no workspace row to put a `+` on yet.

That gap is rendered at `:127-138` as static copy telling the user to go run `falcon` in a
terminal. This directly violates CLAUDE.md auth/UX rule #1: *"Never print 'run X' when you
can run X."* The daemon can create the folder and register it; the web just never asks.

**What already exists, verified end to end:**

- `SpawnResultSchema.requiresApproval.action` — `z.literal(["create-directory", "register-workspace"])`
  (`packages/wire/src/rpc.ts:82-91`, with the "why a literal, not an enum" note at `:71-81`).
- `fs.list` / `fs.mkdir` / `workspace.register` schemas (`rpc.ts:489-542`), handlers
  `fsBrowse.ts:35-83` and `workspaceRegisterRpc.ts:31-52`, registered at
  `machineRpc.ts:699-713`. `fsBrowse.ts:8-15` documents exactly why these two are *not*
  scoped to a registered root: "that's exactly the point of a directory picker".
- `workspace/registry.ts:211-239` — `registerWorkspace` is idempotent and keyed by
  symlink-resolved real path, which *is* the `workspaceId`.
- `spawn-flow.ts:25-57` — `runSpawnFlow(actions, request, confirmApproval)` implements the
  full approval loop with a `SpawnFlowError` for the "still not resolved after resolving
  it" case, and it is **already unit-tested** (`__tests__/spawn-flow.test.ts` covers both
  actions).
- `live-actions.ts:31-95` — `machineRpcToActions` wires all of it to real RPCs.

**What is missing:** any UI that calls `browseDirectory`, or that passes a
`confirmApproval` returning `true`. Both existing callers hard-decline
(`use-inline-spawn.ts:69-75`, `use-review-spawn.ts:51-57`) with a `console.error`, for a
documented reason: for their entry points the approval branch *should* be unreachable.

### 4.2 UX decision recap

Add a **"New project"** entry point that never needs a cross-platform filesystem browser:

- **Fixed, visible base directory: `~/falcon-workspaces/`.** Not inside `~/.falcon/` —
  that is reserved for app state (`workspace/registry.ts:16` puts `workspaces.json` there;
  `runStateStore.ts` puts `run-state.json` there; `~/.falcon/access.key` holds key
  material). A user's source code does not belong in an app-state directory, and
  `docs/uninstall.md` tells people to `rm -rf ~/.falcon`.
- **A generated, memorable, editable folder name**, validated as a single safe path
  segment: no `/`, no `\`, no `..`, no leading `.`, no NUL, length-capped. The repo already
  has `features/new-session/auto-branch.ts`'s `generateBranchName()` producing
  memorable names for branches — reuse that generator's word lists rather than inventing a
  second style.
- **The full resulting path is shown read-only**: `~/falcon-workspaces/<name>`. The user
  edits only the last segment. This is what makes a filesystem browser unnecessary.
- **Reuse the existing approval loop unchanged.** `runSpawnFlow` is called with a
  `confirmApproval` that returns `true` for both actions (after the user has already
  confirmed in the panel), so `fs.mkdir` creates the folder and `workspace.register`
  registers it. **Zero new RPCs, zero wire changes.**
- **`git init` is Feature 1's job.** A brand-new folder is not a repo, so the first Git
  panel visit lands on `workspace-not-a-repo` — which, after Feature 1, offers "Set up git
  here". That is the intended composition and is why Feature 1 should ship first.
- **Phase 2 (nice to have, explicitly NOT required for MVP): "Clone from GitHub URL."**
  Design sketched in [§4.7](#47-phase-2-nice-to-have--clone-from-github-url).

**Home-directory resolution.** The web must not guess the machine's home path.
`fs.list` with `path` omitted returns `homedir()` and echoes the resolved absolute path
back (`fsBrowse.ts:36`, `FsListResultSchema.path` at `rpc.ts:502-508`). So: one
`browseDirectory()` call with no argument yields the home path, and the panel appends
`falcon-workspaces/<name>`. This is the *only* use of `fs.list` in the flow — no browsing
UI, one call, purely to learn where home is.

### 4.3 Wire protocol changes

**None for the MVP.** Every schema is already in place. (Phase 2's `git.clone` would need
new schemas — see §4.7.)

### 4.4 Daemon changes

**None for the MVP.**

One risk to verify before shipping, because it is the single thing that could break the
flow: `spawn`'s validation path. `spawnEngine.ts` uses `workspacePath.ts`'s
`validateSpawnWorkspace` (`:43-83`), which returns `{ok:false, reason:"unknown-workspace"}`
when `lookupRoot(workspaceId)` yields nothing, and `"not-found"` when the directory does
not resolve. `SpawnResult.requiresApproval` is produced from those reasons. The flow
depends on a **fresh path producing `create-directory` first, then `register-workspace`
on the retry** — two round trips through `runSpawnFlow`, but `runSpawnFlow` only retries
**once** (`spawn-flow.ts:49-56`) and then throws `SpawnFlowError`.

**This is the one genuine implementation risk in Feature 4** and it must be checked
against `spawnEngine.ts` before writing the UI. If `spawn` returns the two approvals
sequentially, the panel must not call `runSpawnFlow` blind. The clean answer, which also
gives better UX, is to **resolve both approvals up front** and only then spawn:

```ts
await actions.createDirectory(fullPath);      // fs.mkdir  — idempotent (`mkdir -p`)
await actions.registerWorkspace(fullPath);    // workspace.register — idempotent
const outcome = await actions.spawn(request); // should now succeed outright
```

Both calls are idempotent by contract (`fsBrowse.ts:70`, `workspaceRegisterRpc.ts:30`), and
`runSpawnFlow` is still used for the spawn itself as a belt-and-braces fallback. This keeps
`spawn-flow.ts` untouched.

### 4.5 Web changes

#### New file: `packages/web/src/features/new-session/new-workspace.ts` (pure logic)

```ts
/**
 * Pure logic for the "New project" flow (docs/web-ux-improvements-plan.md
 * Feature 4) — no React, no RPC, so it is unit-testable in a package whose
 * vitest runs `environment: "node"`. Same split as `inline-spawn.ts`/
 * `wizard-state.ts`/`file-tree-logic.ts`.
 *
 * WHY A FIXED BASE DIRECTORY: a genuine cross-platform filesystem browser is
 * a large piece of UI (and a mobile-hostile one). A single visible, boring
 * location the user can find in Finder/Explorer removes the need for it
 * entirely — the user names a folder, sees exactly where it will be, and
 * that's the whole decision.
 *
 * WHY NOT `~/.falcon/`: that directory is app state, not user data —
 * `workspace/registry.ts` keeps `workspaces.json` there, `runStateStore.ts`
 * keeps `run-state.json`, the CLI keeps `access.key`, and
 * `docs/uninstall.md` tells people to `rm -rf ~/.falcon` to uninstall.
 * Putting source code there would make uninstalling delete the user's work.
 */

/** The single, visible base directory every web-created project lands in, relative to the machine's home directory. */
export const WORKSPACE_BASE_DIR = "falcon-workspaces";

export type WorkspaceNameError =
  | "empty"
  | "has-separator"
  | "traversal"
  | "hidden"
  | "too-long"
  | "invalid-char";

/**
 * Validates a folder name as ONE safe path segment. Rejects anything that
 * could escape `~/falcon-workspaces/` or confuse a shell/filesystem. This is
 * defense in depth, not the security boundary: `fs.mkdir` requires an
 * absolute path (`fsBrowse.ts`) and `spawn` validates against the registry
 * (`workspacePath.ts`) — but an escaping name would produce a genuinely
 * wrong (if still authorized) directory, so it is caught here where the user
 * can actually fix it.
 */
export function validateWorkspaceName(raw: string): WorkspaceNameError | null {
  const name = raw.trim();
  if (name === "") return "empty";
  if (name.includes("/") || name.includes("\\")) return "has-separator";
  if (name === "." || name === ".." || name.includes("..")) return "traversal";
  if (name.startsWith(".")) return "hidden";
  if (name.length > 64) return "too-long";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL and control characters are exactly what this rejects.
  if (/[\u0000-\u001f<>:"|?*]/.test(name)) return "invalid-char";
  return null;
}

/** Plain-language message per error — no internal vocabulary (CLAUDE.md auth/UX rule #4). */
export const WORKSPACE_NAME_ERROR_COPY: Record<WorkspaceNameError, string> = {
  empty: "Give the project a name.",
  "has-separator": "Use just a name — no slashes.",
  traversal: "That name isn't allowed. Try something simpler.",
  hidden: "Names starting with a dot are hidden — pick another.",
  "too-long": "That name is too long.",
  "invalid-char": "That name has characters a folder can't use.",
};

/**
 * Builds the absolute path a named project will live at. `home` is the
 * machine's own home directory as the daemon reported it (`fs.list` with no
 * `path` returns `homedir()` and echoes the RESOLVED absolute path back —
 * `fsBrowse.ts` / `FsListResult.path`), never guessed client-side: the web
 * has no idea whether the machine is `/Users/x`, `/home/x` or `C:\Users\x`.
 *
 * Joined with `/` because every machine RPC path in this codebase is posix
 * (`git.files` returns posix-separated paths; `workspace/registry.ts` keys on
 * a posix real path). Windows support for this flow is an open question — see
 * this feature's rollout notes.
 */
export function buildWorkspacePath(home: string, name: string): string {
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  return `${base}/${WORKSPACE_BASE_DIR}/${name.trim()}`;
}

/** The `~`-abbreviated form to SHOW the user; the absolute form is what's sent over the wire. */
export function displayWorkspacePath(home: string, name: string): string {
  return `~/${WORKSPACE_BASE_DIR}/${name.trim()}`;
}
```

#### New file: `packages/web/src/features/new-session/use-new-workspace.ts`

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { translateSpawnError } from "@/features/session-list";
import { useLiveNewSessionActions } from "./live-source";
import { buildWorkspacePath } from "./new-workspace";
import { runSpawnFlow } from "./spawn-flow";
import type { SpawnRequest } from "./types";

/**
 * Creates a brand-new project folder on `machineId`, registers it as a
 * workspace, and spawns the first session in it — the web's answer to
 * "an account with machines but no sessions has nowhere to click"
 * (`features/session-list/session-list-screen.tsx`'s own honest note about
 * that gap, and CLAUDE.md auth/UX rule #1: never print "run X" when you can
 * run X).
 *
 * Adds NO new RPC: `fs.mkdir` (`create-directory`) and `workspace.register`
 * (`register-workspace`) are the exact two approval branches `spawn` already
 * defines (`@falcon/wire`'s `SpawnResult.requiresApproval`), and
 * `spawn-flow.ts`'s `runSpawnFlow` already orchestrates them. The only thing
 * missing was a caller willing to APPROVE: the two existing call sites
 * (`use-inline-spawn.ts`, `use-review-spawn.ts`) both hard-decline, correctly,
 * because for their entry points a fresh folder is structurally impossible.
 *
 * ⚠ Both approvals are resolved UP FRONT rather than by letting `runSpawnFlow`
 * discover them, because `runSpawnFlow` retries `spawn` exactly ONCE before
 * throwing `SpawnFlowError` — and a genuinely fresh path needs BOTH a
 * directory and a registration. Both calls are idempotent by contract
 * (`fsBrowse.ts`'s `mkdir -p`, `workspace/registry.ts`'s
 * register-twice-is-a-no-op), so doing them eagerly costs one round trip each
 * and can never do harm. `runSpawnFlow` is still used for the spawn itself, as
 * a fallback for anything that changed underneath us.
 */
export type NewWorkspaceState =
  | { phase: "idle" }
  | { phase: "creating"; step: "folder" | "registering" | "starting" }
  | { phase: "success"; sessionId: string; directory: string }
  | { phase: "error"; message: string };

export function useNewWorkspace(machineId: string) {
  const actions = useLiveNewSessionActions(machineId);
  const [home, setHome] = useState<string | null>(null);
  const [state, setState] = useState<NewWorkspaceState>({ phase: "idle" });
  const generation = useRef(0);

  // One `fs.list` with no `path`, purely to learn where this machine's home
  // directory is — NOT a browsing UI. `fsBrowse.ts` defaults to `homedir()`
  // and echoes back the resolved absolute path, which is the only reliable
  // way for the web to know whether it's `/Users/x`, `/home/x`, or something
  // else entirely.
  useEffect(() => {
    let cancelled = false;
    actions
      .browseDirectory()
      .then((listing) => {
        if (!cancelled) setHome(listing.path);
      })
      .catch(() => {
        // Leave `home` null — the panel renders "couldn't reach that machine"
        // and the create button stays disabled. Never guess a path.
      });
    return () => {
      cancelled = true;
    };
  }, [actions]);

  const create = useCallback(
    (name: string, request: Omit<SpawnRequest, "directory">) => {
      if (home === null) return;
      const myGeneration = ++generation.current;
      const directory = buildWorkspacePath(home, name);

      void (async () => {
        try {
          setState({ phase: "creating", step: "folder" });
          await actions.createDirectory(directory);
          if (generation.current !== myGeneration) return;

          setState({ phase: "creating", step: "registering" });
          await actions.registerWorkspace(directory);
          if (generation.current !== myGeneration) return;

          setState({ phase: "creating", step: "starting" });
          const result = await runSpawnFlow(actions, { ...request, directory }, async () => true);
          if (generation.current !== myGeneration) return;

          if (result.outcome === "spawned") {
            setState({ phase: "success", sessionId: result.sessionId, directory });
            return;
          }
          setState({ phase: "error", message: "Couldn't start a session in the new project." });
        } catch (err: unknown) {
          if (generation.current !== myGeneration) return;
          const raw = err instanceof Error ? err.message : String(err);
          setState({ phase: "error", message: translateSpawnError(raw) });
        }
      })();
    },
    [actions, home],
  );

  return { home, state, create, reset: () => { generation.current++; setState({ phase: "idle" }); } };
}
```

The `generation` ref guard is copied verbatim in spirit from `use-inline-spawn.ts:61,77`
— this codebase's established pattern for "a stale async response must not land".

#### New file: `packages/web/src/features/session-list/components/new-workspace-panel.tsx`

Structurally a sibling of `new-session-panel.tsx`: a `Dialog` with

- a **Name** `Input`, prefilled from `generateBranchName()` (`features/new-session/auto-branch.ts`),
  validated live via `validateWorkspaceName` with `WORKSPACE_NAME_ERROR_COPY` inline;
- a **read-only** path line showing `displayWorkspacePath(home, name)` with the note
  *"This folder will be created on <machine name>."*;
- the same Advanced disclosure (`ProviderPicker` / `PermissionModePicker` / `ModelPicker`)
  `new-session-panel.tsx:299-335` already composes;
- `MachineOfflineNotice` from Feature 2 and a Create button disabled while
  `machineUnavailable || home === null || validateWorkspaceName(name) !== null`;
- a per-step status line driven by `state.step` ("Creating the folder…" / "Setting it
  up…" / "Starting your session…"), reusing `InlineSpawnStatus`'s shape.

#### Entry points

1. `session-list-screen.tsx:127-138` — the "No sessions yet" branch. Replace the static
   *"Run `falcon` from a project"* copy with the panel's trigger **plus** the existing copy
   as a secondary path. Both are legitimate; only one of them is clickable today.
2. `session-list-screen.tsx:141-149` — add a "New project" button next to "Completed" in
   the header, so the flow is reachable once workspaces exist too.
3. `first-machine-onboarding.tsx` — **unchanged**. With zero machines there is nothing to
   create a folder *on*, and that screen already advances by itself (`:33-35`).

### 4.6 Testing plan

- **`packages/web/src/features/new-session/__tests__/new-workspace.test.ts`** (new) —
  `validateWorkspaceName`: `""`/whitespace → `"empty"`; `"a/b"` and `"a\\b"` →
  `"has-separator"`; `".."`, `"a..b"` → `"traversal"`; `".hidden"` → `"hidden"`; 65 chars →
  `"too-long"`; `"a\u0000b"` and `'a"b'` → `"invalid-char"`; ordinary names → `null`.
  `buildWorkspacePath("/Users/me", " my app ")` → `"/Users/me/falcon-workspaces/my app"`;
  a trailing-slash home is normalized; `displayWorkspacePath` always renders the `~` form.
  Assert `WORKSPACE_NAME_ERROR_COPY` has an entry for every `WorkspaceNameError` (a
  `Record` already type-enforces it; the test guards against the union growing).
  Assert `WORKSPACE_BASE_DIR` does **not** start with `.` — a direct regression test for
  the "don't hide it in `~/.falcon`" decision.
- **`packages/web/src/features/new-session/__tests__/use-new-workspace.test.ts`** (new) —
  the `renderToStaticMarkup` capture harness from `use-git-panel.test.ts:36-48` with a
  fully faked `NewSessionActions` (`vi.fn` per method, as
  `__tests__/spawn-flow.test.ts:14-26` already does):
  - `create()` calls `createDirectory` → `registerWorkspace` → `spawn`, **in that order**
    (assert via a shared `calls: string[]`), all with the same absolute path;
  - `browseDirectory` rejecting leaves `home === null` and makes `create()` a no-op;
  - a `spawn` that still reports `requiresApproval` after both resolutions surfaces an
    error state, never a false success;
  - a thrown `MachineRpcError` is passed through `translateSpawnError`;
  - a second `create()` invalidates the first's pending result (generation guard).
- **`packages/web/src/features/session-list/components/new-workspace-panel.test.tsx`**
  (new) — `renderToStaticMarkup` with the `defaultOpen` escape hatch
  (`new-session-panel.tsx:62-64`'s documented precedent): the read-only path line renders
  the `~/falcon-workspaces/<name>` form; an invalid name renders its copy and a disabled
  Create button; an offline machine renders the notice and a disabled button.
- **`packages/web/src/features/session-list/session-list-screen.test.ts`** (extend) — the
  zero-sessions branch renders the new trigger; the zero-*machines* branch still renders
  `FirstMachineOnboarding` unchanged.
- **Daemon/wire: no new tests.** Nothing changes there. Existing coverage
  (`fsBrowse.test.ts`, `workspaceRegisterRpc.test.ts`, `spawn-flow.test.ts`) already covers
  every call this flow makes.
- **One end-to-end manual step** (the runbook in `CLAUDE.md` §"Testing the app end-to-end"):
  fresh account → pair CLI → create a project from the web with no terminal → confirm
  `~/falcon-workspaces/<name>` exists on disk, appears in `~/.falcon/workspaces.json`, and
  the session starts. Then open its Git tab and confirm Feature 1's "Set up git here"
  appears (the intended composition).

### 4.7 Phase 2 (nice to have) — "Clone from GitHub URL"

**Explicitly not required for the MVP of this feature.** Sketched here so the MVP's shape
does not foreclose it.

Paste a repo URL → the daemon clones into `~/falcon-workspaces/<derived-name>` → register →
spawn. Reuses `gitExec.ts`'s `runGit` and the `~/falcon-workspaces` base from the MVP.

**The one genuinely new problem is progress reporting.** A clone can take minutes.
`@falcon/wire`'s `rpc.ts:23-27` and the 64KB control-plane budget (`gitDiff.ts:44-45`,
`fsRead.ts:41-42`) make the RPC layer a *control plane*, and `gitExec.ts:38` caps any
single `git` invocation at `GIT_EXEC_TIMEOUT_MS = 15_000`. A synchronous request/response
`git.clone` is therefore doubly wrong: it would blow the 15s exec timeout and the relay's
own 30s `RPC_CALL_TIMEOUT_MS` (`rpcHandler.ts:23`) on any real repository.

**Recommendation: fire-and-poll, mirroring `run.status` exactly.** `runProcess.ts` already
solves this shape — `run.start` returns immediately (`handleRunStart` → `{started:true, pid, method}`),
state is persisted in `~/.falcon/run-state.json` (`runStateStore.ts`), and `run.status`
(`handleRunStatus`, `runProcess.ts:297-336`) is polled by the web at 5s while active
(`use-run-panel.ts:31-35`). A clone is structurally the same thing: a long child process
whose output goes to a log file and whose state is a small persisted record.

```ts
// `git.clone`/`git.cloneStatus` — sketch only, NOT part of this plan's MVP.
export const GitCloneParamsSchema = z.object({
  idempotencyKey: z.string(),
  /** The repository URL to clone. Never shell-interpolated; passed as its own argv element. */
  url: z.string(),
  /** Absolute destination path — always under the fixed base directory the caller shows the user. */
  directory: z.string(),
});

// Returns IMMEDIATELY — the clone runs detached, exactly like `run.start`.
export const GitCloneResultSchema = z.object({
  started: z.boolean(),
  alreadyRunning: z.boolean().optional(),
  alreadyExists: z.boolean().optional(),
});

export const GitCloneStatusParamsSchema = z.object({
  idempotencyKey: z.string(),
  directory: z.string(),
});

// Structural clone of `RunStatusResult.setup` — same state enum shape, same
// `logTail` "inline only, deliberately partial" contract.
export const GitCloneStatusResultSchema = z.object({
  state: z.enum(["none", "cloning", "succeeded", "failed"]),
  exitCode: z.number().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  /** Last few KB of the clone's own output — git's `--progress` lines. Never a structured percentage: git's progress format is not a stable contract. */
  logTail: z.string().optional(),
});
```

Why **not** the ephemeral/attention channel for progress: `EphemeralSchema`
(`updates.ts:88-126`) is a fixed discriminated union whose members are all
session/machine/key-scoped, and ephemerals are explicitly "safe to coalesce/drop under
backpressure" (`:84-87`). Dropping a progress frame is fine; dropping the *terminal*
frame is not — a clone that finished while a frame was dropped would look stuck forever.
Polling has no such failure mode, and it reuses machinery that already exists and is
already tested. If live progress is wanted later, the ephemeral channel can be *added* on
top of the poll as an optimization, never as the source of truth.

Additional notes for whoever builds it:
- The destination must be inside the fixed base directory — validated daemon-side, not
  just in the UI, since `git clone` into an arbitrary path is a write primitive.
- `git clone` into a **non-empty** directory fails; the handler should report
  `alreadyExists` rather than surface a raw git error.
- Auth: same "no credential management" stance as `gitPush.ts:16-19`. A private repo over
  HTTPS with no cached credential helper fails fast thanks to
  `GIT_TERMINAL_PROMPT=0` (`gitExec.ts:49`) — good — but the error copy needs to say so
  plainly rather than passing git's stderr through.
- The 15s `GIT_EXEC_TIMEOUT_MS` cap means the clone **cannot** go through `runGit`. It
  needs its own detached spawn with output redirected to a log file, exactly as
  `runProcess.ts` does via `shellCommand.ts`'s `buildShellInvocation`.

### 4.8 Rollout / risk notes

- **No flag for the MVP.** It adds a new entry point that did not exist; there is no
  existing behaviour to regress, and every RPC it calls is already in production use.
- **The `spawn` double-approval question (§4.4) must be verified against `spawnEngine.ts`
  before the UI is written.** The eager-resolution design makes it moot, but the
  implementer should confirm rather than assume.
- **Windows is an open question.** `buildWorkspacePath` joins with `/`, matching every
  other path in this system. `fsBrowse.ts` uses `node:path` (platform-native) and
  `workspace/registry.ts` keys on `realpath`. Mixed separators on Windows would probably
  work but are untested, and nothing else in this repo exercises a Windows daemon.
  Recommendation: ship posix-first, and have the panel refuse (with honest copy) if
  `fs.list`'s returned home path contains a `\`.
- **Name collision:** `fs.mkdir` is `mkdir -p`, so creating a project whose name already
  exists silently reuses the existing folder — which may already contain someone's work.
  The MVP should call `fs.list` on `~/falcon-workspaces` before creating and warn on a
  collision. That is one extra RPC call, no new schema, and it prevents a genuinely
  confusing outcome.
- **Phase 2's `git.clone` is a real write primitive** and should be reviewed as one, not
  as a UI convenience. It is the only part of this plan that would warrant a
  `FALCON_*` env flag daemon-side.

---

## 5. Suggested implementation order

```
Feature 3 Phase 1  ──▶  Feature 2  ──▶  Feature 1  ──▶  Feature 4 MVP  ──▶  Feature 3 Phases 2-5  ──▶  Feature 4 Phase 2
   (bug fix)          (shared hook)     (new RPCs)       (uses both)         (deps + virtualization)      (git.clone)
```

1. **Feature 3, Phase 1 — first, alone, immediately.** It is a genuine bug fix (an infinite
   main-thread loop, §3.1a), needs no new dependency, changes no UX, and unblocks nothing —
   which is exactly why it should not wait behind anything.
2. **Feature 2 — second.** It is pure web, adds no wire surface, and produces
   `useMachineOnline` + `MachineOfflineNotice`, both of which Features 1 and 4 consume.
   Doing it first means their new buttons are offline-aware from day one instead of needing
   a follow-up pass. It also has the best effort-to-relief ratio in the whole plan: it
   removes a ~17-second dead wait from every panel.
3. **Feature 1 — third.** Wire + daemon + web, but a well-trodden path (three near-identical
   mutating git RPCs already exist to copy). It must land **before** Feature 4, because a
   freshly-created project is by definition not a git repo, and "Set up git here" is the
   screen the user hits immediately after creating one. Shipping Feature 4 first would
   route every new user straight into the dead end Feature 1 exists to remove.
4. **Feature 4 MVP — fourth.** Almost pure UI on top of a complete backend, and it composes
   the previous two (offline-aware Create button; Git panel that can initialize itself).
   It closes the honest gap `session-list-screen.tsx:59-68` documents.
5. **Feature 3, Phases 2-5 — fifth.** The largest diff and the only one adding
   dependencies. Split further: 3.2 (worker) → 3.3 file/diff lines → 3.3 file tree →
   3.4 diff library → 3.3 Timeline (flagged) → 3.5 truncation. Each is independently
   shippable and independently revertible.
6. **Feature 4 Phase 2 (`git.clone`) — last, and optional.** It is the only genuinely new
   backend capability in the plan and the only place that needs a new long-running-process
   subsystem. It should not gate anything above it.

**Dependency notes:**
- Feature 2's `useMachineOnline` → consumed by Feature 1's `GitToolbar`/`GitStatusError` and
  Feature 4's panel.
- Feature 1's `git.init` → the natural next step after Feature 4 creates a folder.
- Feature 3 is independent of all of them; it shares no files with 1, 2 or 4 except
  `use-repo-files.ts` (Feature 2 adds a re-fetch effect; Feature 3 adds a `useMemo`) and
  `UnifiedDiffViewer.tsx`. Sequence 2 before 3.3 to avoid a conflict there.
- Nothing in this plan requires a `packages/server` change.
