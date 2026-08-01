import { z } from "zod";
import { EncryptedBoxSchema } from "./box";
import { PermDecisionSchema, PermissionModeSchema } from "./permissions";
import { ProviderIdSchema } from "./providers";
import { SessionEnvelopeSchema } from "./session";

/**
 * RPC call envelope sent over the WS `rpc-call` client emit (design §4.4).
 * `target` is scope-prefixed: `m:<machineId>:<method>` (daemon-registered)
 * or `s:<sessionId>:<method>` (session-process-registered). Params/results
 * are always an `EncryptedBox` — the relay forwards opaque bytes and never
 * inspects RPC bodies.
 */
export const RpcCallSchema = z.object({
  target: z.string(),
  method: z.string(),
  params: EncryptedBoxSchema,
});
export type RpcCall = z.infer<typeof RpcCallSchema>;

// ---------------------------------------------------------------------------
// Machine RPCs — registered by the daemon (design §4.4)
//
// `idempotencyKey` is required on spawn/adopt.*/git.*/fs.read: an RPC ack can
// legitimately be lost after the daemon already ran the call (dead-peer
// fast-fail races the real response), so every caller-retriable machine RPC
// carries a caller-minted key the daemon can use to replay its prior result
// instead of re-running a side effect (or re-reading a file mid-write twice).
// ---------------------------------------------------------------------------

export const SpawnParamsSchema = z.object({
  idempotencyKey: z.string(), // cuid2 minted by caller; daemon replays the prior result on retry
  workspaceId: z.string(),
  directory: z.string(),
  provider: ProviderIdSchema,
  permissionMode: PermissionModeSchema,
  model: z.string().optional(),
  branch: z
    .object({
      name: z.string(),
      createWorktree: z.boolean(),
      // The base ref a brand-new branch is created from (docs/competitive-notes-omnara.md
      // #16 "searchable base-branch picker") — e.g. `main`/`master` instead of
      // always forking off whatever's currently checked out at `directory`.
      // Optional and additive: omitted (or a branch that already exists, where
      // there's no "base" to speak of) preserves the old behavior of branching
      // from the current HEAD.
      from: z.string().optional(),
    })
    .optional(),
  continueFrom: z
    .object({
      providerSessionId: z.string(),
    })
    .optional(),
});
export type SpawnParams = z.infer<typeof SpawnParamsSchema>;

// `sessionId` is optional (rather than the union `SpawnSessionResult` the
// daemon's loopback controlServer contract uses internally,
// packages/cli/src/daemon/types.ts) because the additive-only policy
// (design §5.3) forbids retyping an already-shipped required field into a
// union — schemaRegistry.ts's compat check would reject that. `requiresApproval`
// is the wire-safe equivalent of that contract's
// `requestToApproveDirectoryCreation` case (plan.md §16 "3.1 Remote spawn"
// — "409 directory-creation approval loop"): the target directory doesn't
// exist yet, so the caller offers to create it (`fs.mkdir`) and retries
// `spawn` with the same `idempotencyKey`. Exactly one of `sessionId` /
// `requiresApproval` is set on any successful (non-throwing) response.
//
// `action` is a multi-value literal, not a `z.enum` (plan.md §16 "Flow 3 —
// spawn-fresh-folder-register (Piece A)"): the additive-only compat check
// (`__tests__/schemaShape.ts`'s `isCompatible`) treats a schema's `kind` as
// part of its frozen shape, and `describeShape` reports `z.literal(...)` and
// `z.enum([...])` as two *different* kinds — so swapping to `z.enum` here
// would be a breaking kind change under the frozen fixture even though the
// value set only grew. `"register-workspace"` is the second action: a
// `spawn` whose `workspaceId` was never registered (a genuinely fresh
// folder picked cold in the web UI — kvy-prd.md FR-7.5, plan.md §16
// "3.1 Remote spawn") resolves to this instead of throwing, mirroring the
// `"create-directory"` loop — the caller confirms, registers it (the new
// `workspace.register` RPC below), and retries `spawn`.
export const SpawnResultSchema = z.object({
  sessionId: z.string().optional(),
  requiresApproval: z
    .object({
      action: z.literal(["create-directory", "register-workspace"]),
      directory: z.string(),
    })
    .optional(),
});
export type SpawnResult = z.infer<typeof SpawnResultSchema>;

export const StopSessionParamsSchema = z.object({
  sessionId: z.string(),
  force: z.boolean().optional(),
});
export const StopSessionResultSchema = z.object({ ok: z.boolean() });

export const ResumeSessionParamsSchema = z.object({ sessionId: z.string() });
export const ResumeSessionResultSchema = z.object({ ok: z.boolean() });

export const ListSessionsParamsSchema = z.object({});

export const LocalSessionInfoSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  provider: ProviderIdSchema,
  controlMode: z.enum(["local", "remote"]),
  status: z.enum(["active", "failed", "stopped"]),
  pid: z.number().optional(),
  startedAt: z.number(),
});
export type LocalSessionInfo = z.infer<typeof LocalSessionInfoSchema>;

export const ListSessionsResultSchema = z.object({
  sessions: z.array(LocalSessionInfoSchema),
});

export const GitStatusParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
});
export type GitStatusParams = z.infer<typeof GitStatusParamsSchema>;

export const FileStatusSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
  /** Lines added/removed vs the comparison ref (`git diff --numstat`) — absent for an untracked file (never diffed, no ref-relative content to count) or a binary file (`git` reports `-`/`-` for those, not a real count). */
  insertions: z.number().optional(),
  deletions: z.number().optional(),
});
export type FileStatus = z.infer<typeof FileStatusSchema>;

export const GitStatusResultSchema = z.object({
  branch: z.string(),
  ahead: z.number(),
  behind: z.number(),
  files: z.array(FileStatusSchema),
});
export type GitStatusResult = z.infer<typeof GitStatusResultSchema>;

export const GitDiffParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
  path: z.string().optional(),
  baseRef: z.string().optional(),
});
export type GitDiffParams = z.infer<typeof GitDiffParamsSchema>;

// `truncated` mirrors `FsReadResultSchema`'s own field below — same "no blob
// subsystem yet" contract (design §4.4 "payload size rule"): a diff that
// would blow the 64KB RPC control-plane budget is truncated inline rather
// than dropped, and `truncated: true` tells the caller more content exists.
// `blobRef` is the reserved extension point for the eventual blob-storage
// fallback (plan.md §16 "4.3 Distribution & self-host") — unset until that
// subsystem lands, same as `adopt.mirror`'s own not-yet-wired `blobRef`.
export const GitDiffResultSchema = z.object({
  inline: z.string().optional(),
  blobRef: z.string().optional(),
  truncated: z.boolean(),
});
export type GitDiffResult = z.infer<typeof GitDiffResultSchema>;

// `git.branches` machine RPC (design §4.4, docs/features/worktree-isolation.md
// Phase 1): lists local branches for the existing-branch worktree picker.
// Structural clone of `git.status`'s params shape above.
export const GitBranchesParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
});
export type GitBranchesParams = z.infer<typeof GitBranchesParamsSchema>;

// `checkedOutAt` is the absolute worktree path currently holding this branch
// (git forbids the same branch in two worktrees — callers should disable
// such rows). `lastCommitAt` is unix seconds from `%(committerdate:unix)`.
// `refs/heads` always; `refs/remotes` too (each entry marked `remote: true`)
// when the repo has at least one configured remote.
export const GitBranchInfoSchema = z.object({
  name: z.string(),
  isCurrent: z.boolean(),
  checkedOutAt: z.string().optional(),
  upstream: z.string().optional(),
  lastCommitAt: z.number().optional(),
  remote: z.boolean().optional(),
});
export type GitBranchInfo = z.infer<typeof GitBranchInfoSchema>;

export const GitBranchesResultSchema = z.object({
  branches: z.array(GitBranchInfoSchema),
});
export type GitBranchesResult = z.infer<typeof GitBranchesResultSchema>;

// `git.remotes` machine RPC: lists configured git remotes, for the workspace
// settings Git tab's remote-name autofill. Structural clone of `git.branches`.
export const GitRemotesParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
});
export type GitRemotesParams = z.infer<typeof GitRemotesParamsSchema>;

export const GitRemoteInfoSchema = z.object({
  name: z.string(),
  url: z.string(),
});
export type GitRemoteInfo = z.infer<typeof GitRemoteInfoSchema>;

export const GitRemotesResultSchema = z.object({
  remotes: z.array(GitRemoteInfoSchema),
});
export type GitRemotesResult = z.infer<typeof GitRemotesResultSchema>;

// `provider.account` machine RPC (docs/competitive-notes-omnara.md #9
// "Provider account inspection + usage metering"): Settings → Providers'
// per-machine, per-provider account snapshot — read straight off the local
// CLI's own auth config files (`~/.claude.json`'s `oauthAccount`/
// `cachedUsageUtilization`, `~/.codex/auth.json`'s ChatGPT id-token claims —
// see `packages/cli/src/daemon/providerAccountInfo.ts`), never a live call
// to the provider's own API. `idempotencyKey` is carried for uniformity
// with the rest of this RPC family (this module's own header comment) even
// though the handler is a pure read with nothing to replay, same as
// `git.status`/`git.branches`.
export const ProviderAccountParamsSchema = z.object({
  idempotencyKey: z.string(),
  provider: ProviderIdSchema,
});
export type ProviderAccountParams = z.infer<typeof ProviderAccountParamsSchema>;

// One usage-limit window as the local CLI's own cache reports it (Claude
// Code's `~/.claude.json` `cachedUsageUtilization.utilization.{five_hour,
// seven_day}` today) — `label` and the bucket period itself come straight
// from whatever the CLI happens to track, never invented or normalized to a
// fixed "monthly" cadence the CLI doesn't actually use.
export const ProviderUsageMeterSchema = z.object({
  label: z.string(),
  /** 0-100 in the common case; a provider can report a promo/grace overage above 100. */
  percentUsed: z.number(),
  /** ISO 8601 instant this usage window resets. */
  resetsAt: z.string(),
});
export type ProviderUsageMeter = z.infer<typeof ProviderUsageMeterSchema>;

// Every field past `provider`/`authenticated` is optional and omitted
// rather than fabricated whenever the local config doesn't carry it (design
// principle: no silent data loss, but also no invented data) — e.g. Codex's
// local auth file caches no usage utilization at all, so `usage` is simply
// absent for it, and an API-key-authenticated account has no email/org to
// show.
export const ProviderAccountResultSchema = z.object({
  provider: ProviderIdSchema,
  authenticated: z.boolean(),
  /** e.g. "oauth", "api-key", "chatgpt" — the local auth mechanism in use, read from the CLI's own config. */
  authType: z.string().optional(),
  email: z.string().optional(),
  organization: z.string().optional(),
  organizationRole: z.string().optional(),
  /** Raw value from the CLI's own config (e.g. "stripe_subscription", "free") — the caller formats it for display. */
  billingType: z.string().optional(),
  /** Unix ms — when the CLI itself last refreshed this cached account/usage snapshot (`profileFetchedAt`/`last_refresh`), not "now". */
  lastRefreshedAt: z.number().optional(),
  usage: z.array(ProviderUsageMeterSchema).optional(),
});
export type ProviderAccountResult = z.infer<typeof ProviderAccountResultSchema>;

// `git.files` machine RPC (design §4.4's "fs.read"/Repo Files sidebar tab,
// docs/competitive-notes-omnara.md #5 "Full repo file browser"): the flat
// file listing that backs the file tree, joining `git.status`/`git.diff`/
// `git.branches` in the `git.*` family above. `git ls-files --cached
// --others --exclude-standard` (tracked + untracked-but-not-ignored) is the
// listing source rather than a raw recursive `fs.readdir` walk: a repo file
// browser has no business surfacing `node_modules`/build output/anything
// `.gitignore` already excludes, and git already knows exactly which paths
// those are without this needing its own ignore-file parser. Structural
// clone of `git.status`'s params shape.
export const GitFilesParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
});
export type GitFilesParams = z.infer<typeof GitFilesParamsSchema>;

// Flat list of worktree-relative paths (posix-separated, as git itself
// emits) — the web file tree groups these into a nested structure
// client-side rather than this RPC returning a pre-built tree, keeping the
// wire contract a plain, cheap-to-cache array.
export const GitFilesResultSchema = z.object({
  files: z.array(z.string()),
});
export type GitFilesResult = z.infer<typeof GitFilesResultSchema>;

// `commands.list` machine RPC ("/" slash-command autocomplete,
// docs/competitive-notes-omnara.md #18): lists the project's own custom
// Claude Code slash commands, read live from `.claude/commands/` in the
// session's worktree — a structural clone of `git.branches`'s params shape
// above (same "no idempotency-key replay needed, just uniformity" reasoning
// as `git.status`/`git.diff`/`git.branches`: this only reads the current
// `.claude/commands/` tree, so a retry just re-reads it).
export const SlashCommandsListParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
});
export type SlashCommandsListParams = z.infer<typeof SlashCommandsListParamsSchema>;

// `name` is the command's full invocation name, including any subdirectory
// namespace prefix joined with `:` (`.claude/commands/git/commit.md` ->
// `"git:commit"`) — matching Claude Code's own subdirectory-namespacing
// convention. `description`/`argumentHint` come from the command file's
// optional YAML-ish frontmatter (`description: ...` / `argument-hint: ...`)
// — both absent when the file has no frontmatter block at all.
export const SlashCommandInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  argumentHint: z.string().optional(),
});
export type SlashCommandInfo = z.infer<typeof SlashCommandInfoSchema>;

export const SlashCommandsListResultSchema = z.object({
  commands: z.array(SlashCommandInfoSchema),
});
export type SlashCommandsListResult = z.infer<typeof SlashCommandsListResultSchema>;

// `git.commit` machine RPC (design §4.4, docs/features/git-write-actions.md
// Phase 1 — the first *mutating* git RPC; `git.status`/`git.diff`/
// `git.branches` above are all read-only). `stageAll: true` runs `git add
// -A` before committing, so the commit includes exactly what the panel's
// changed-files list shows — untracked files included; omitted/`false`
// commits only already-tracked changes (`git commit -a`). Unlike its
// read-only siblings, a retried `git.commit` MUST replay the prior
// commit's result rather than mint a second commit — see `machineRpc.ts`'s
// `withIdempotencyCache`. `amend` was deliberately left off this schema: no
// UI consumes it yet, and the additive-only policy means it can be added
// later without a breaking change.
export const GitCommitParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
  message: z.string(),
  stageAll: z.boolean().optional(),
});
export type GitCommitParams = z.infer<typeof GitCommitParamsSchema>;

// `nothingToCommit: true` (with `committed: false`) is the clean "nothing
// changed" outcome, not an error — the working tree was already clean (or
// `stageAll` staged nothing new). `commitSha` is set whenever `committed`
// is true.
export const GitCommitResultSchema = z.object({
  committed: z.boolean(),
  commitSha: z.string().optional(),
  nothingToCommit: z.boolean().optional(),
});
export type GitCommitResult = z.infer<typeof GitCommitResultSchema>;

// `git.push` machine RPC (design §4.4, docs/features/git-write-actions.md
// Phase 1). `force: true` maps to `--force-with-lease`, NEVER the raw
// `--force` flag — the raw flag is deliberately unreachable over the wire
// as a data-loss containment measure (a lease-checked force-push still
// fails, rather than silently discarding, when the remote moved since the
// caller's last fetch). Also idempotency-cached, same rationale as
// `git.commit`: re-pushing the same commits is close to a natural no-op,
// but a force-push-with-lease can fail differently on replay, so it's
// cached too rather than assumed safe to blindly re-run.
export const GitPushParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
  remote: z.string().optional(),
  branch: z.string().optional(),
  force: z.boolean().optional(),
  setUpstream: z.boolean().optional(),
});
export type GitPushParams = z.infer<typeof GitPushParamsSchema>;

export const GitPushResultSchema = z.object({
  ok: z.literal(true),
  remote: z.string(),
  branch: z.string(),
  forced: z.boolean(),
});
export type GitPushResult = z.infer<typeof GitPushResultSchema>;

// `git.renameBranch` machine RPC (design §4.4, docs/features/
// git-write-actions.md Phase 1): local-only `git branch -m` (the remote
// branch, if any, keeps its old name until the next push — `hadUpstream`
// tells the UI to surface that warning).
export const GitRenameBranchParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
  to: z.string(),
  from: z.string().optional(),
});
export type GitRenameBranchParams = z.infer<typeof GitRenameBranchParamsSchema>;

export const GitRenameBranchResultSchema = z.object({
  ok: z.literal(true),
  branch: z.string(),
  hadUpstream: z.boolean(),
});
export type GitRenameBranchResult = z.infer<typeof GitRenameBranchResultSchema>;

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

// Modelled on `GithubChecksResultSchema.state` (below): every outcome the
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
//                            real repo root is.
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
// the wire — a caller that wants one uses a terminal.
//
// `url` is passed as its own argv element and is validated only for the
// argv-injection hazard (a leading `-`), NOT for reachability: Kvy manages
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

// `github.checks` machine RPC (design §4.4; docs/features/github-pr-ci.md
// "GitHub PR/CI integration", docs/competitive-notes-omnara.md #4).
// Structural clone of `git.status`/`git.branches`'s params shape above —
// the daemon resolves the PR/CI state for the current branch of
// `params.worktree` using a machine-local GitHub token, never one held by
// the server (design §5.3/§6.1: the server decrypts nothing).
export const GithubChecksParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
});
export type GithubChecksParams = z.infer<typeof GithubChecksParamsSchema>;

// One GitHub check-run (a single job within a PR's combined CI status).
// `startedAt`/`completedAt` are unix seconds, matching `GitBranchInfoSchema`'s
// own `lastCommitAt` precedent above.
export const CheckRunSchema = z.object({
  name: z.string(),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z
    .enum([
      "success",
      "failure",
      "neutral",
      "cancelled",
      "skipped",
      "timed_out",
      "action_required",
      "stale",
    ])
    .optional(),
  detailsUrl: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
});
export type CheckRun = z.infer<typeof CheckRunSchema>;

export const PullRequestInfoSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  headSha: z.string(),
  draft: z.boolean().optional(),
});
export type PullRequestInfo = z.infer<typeof PullRequestInfoSchema>;

// `state` covers every case the "Checks" tab / Settings → Git CTA copy
// derives from (design principle #3 — never stored, always recomputed):
//   - "no-token":            GitHub is not connected on this machine — the
//                             daemon's Settings CTA ("Login to GitHub…").
//   - "unsupported-remote":  the configured remote isn't github.com (or is
//                             detached HEAD/unparseable) — `message` carries
//                             the specific reason.
//   - "not-pushed":          the current branch hasn't been pushed to the
//                             remote yet — "commit and push, then create a
//                             PR" copy.
//   - "no-pr":                pushed, but no open PR exists for this branch.
//   - "ok":                   `pr` + `checks` are populated from the PR's
//                             head commit.
export const GithubChecksResultSchema = z.object({
  state: z.enum(["no-token", "unsupported-remote", "not-pushed", "no-pr", "ok"]),
  repo: z.object({ owner: z.string(), name: z.string() }).optional(),
  branch: z.string().optional(),
  pr: PullRequestInfoSchema.optional(),
  checks: z.array(CheckRunSchema).optional(),
  message: z.string().optional(),
});
export type GithubChecksResult = z.infer<typeof GithubChecksResultSchema>;

export const FsReadParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
  path: z.string(),
  range: z
    .object({
      start: z.number(),
      end: z.number(),
    })
    .optional(),
});
export type FsReadParams = z.infer<typeof FsReadParamsSchema>;

export const FsReadResultSchema = z.object({
  inline: z.string().optional(),
  blobRef: z.string().optional(),
  truncated: z.boolean(),
});
export type FsReadResult = z.infer<typeof FsReadResultSchema>;

// `fs.list`/`fs.mkdir` — the New Session directory picker's daemon-provided
// browsing RPCs (kvy-prd.md FR-7.5 "workspace/directory picker
// (daemon-provided)"; plan.md §16 "3.1 Remote spawn"). Deliberately NOT
// scoped to a `worktree` like `fs.read` above: picking a brand-new
// directory has to work before any workspace/worktree is registered.
// `spawn`'s own workspace-path validation (`workspacePath.ts`) remains the
// actual "no arbitrary-directory execution" boundary (design §12) — these
// two RPCs only let the caller *see* and *create* directories, never run
// anything in them.
export const FsListParamsSchema = z.object({
  idempotencyKey: z.string(),
  /** Absolute path to list; omitted lists the machine's home directory. */
  path: z.string().optional(),
});
export type FsListParams = z.infer<typeof FsListParamsSchema>;

export const FsEntrySchema = z.object({
  name: z.string(),
  isDirectory: z.boolean(),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

export const FsListResultSchema = z.object({
  /** The resolved absolute path that was listed (symlinks followed). */
  path: z.string(),
  /** Absolute path of the parent directory; `null` at the filesystem root. */
  parent: z.string().nullable(),
  entries: z.array(FsEntrySchema),
});
export type FsListResult = z.infer<typeof FsListResultSchema>;

export const FsMkdirParamsSchema = z.object({
  idempotencyKey: z.string(),
  path: z.string(),
});
export type FsMkdirParams = z.infer<typeof FsMkdirParamsSchema>;

export const FsMkdirResultSchema = z.object({ ok: z.boolean() });
export type FsMkdirResult = z.infer<typeof FsMkdirResultSchema>;

// `workspace.register` (plan.md §16 "Flow 3 — spawn-fresh-folder-register
// (Piece A)"): backs `SpawnResult`'s `register-workspace` approval branch
// above — registers `directory` as a genuine, deliberately-designated
// workspace (`workspace/registry.ts`'s already-idempotent
// `registerWorkspace`), so a `spawn` retried with the same `directory`
// afterward resolves instead of repeating `unknown-workspace`. Deliberately
// NOT folded into `fs.mkdir` — that RPC only ever touches the filesystem
// (design §12's directory-picker carve-out); this one is the actual
// workspace-registry write, kept as its own explicit, user-confirmed act
// per that same design note ("no arbitrary-directory execution from
// remote" must stay an opt-in designation, never an implicit side effect
// of any inbound `spawn`). Idempotent like `fs.mkdir` — registering an
// already-registered directory is a no-op — so, like `fs.list`/`fs.mkdir`,
// it needs no `idempotencyKey` replay cache in `machineRpc.ts` even though
// the field is still carried on the wire for uniformity.
export const WorkspaceRegisterParamsSchema = z.object({
  idempotencyKey: z.string(),
  directory: z.string(),
});
export type WorkspaceRegisterParams = z.infer<typeof WorkspaceRegisterParamsSchema>;

export const WorkspaceRegisterResultSchema = z.object({ ok: z.boolean() });
export type WorkspaceRegisterResult = z.infer<typeof WorkspaceRegisterResultSchema>;

// `workspace.unregister` (known-issues.md #3 "Registered workspaces never
// re-validate their path"): the counterpart to `workspace.register` above —
// removes a stale registry entry once a git RPC (or a future boot-time scan)
// has confirmed the underlying folder is gone/no longer a git repo, so the
// Git panel's "Remove this workspace" action has a real RPC to call instead
// of only ever adding entries. Idempotent like `workspace.register`:
// unregistering an already-gone/never-registered directory is a no-op
// (`workspace/registry.ts`'s `unregisterWorkspace` already returns `false`
// rather than throwing), so this needs no `idempotencyKey` replay cache
// either — the field is still carried for uniformity with the rest of this
// RPC family.
export const WorkspaceUnregisterParamsSchema = z.object({
  idempotencyKey: z.string(),
  directory: z.string(),
});
export type WorkspaceUnregisterParams = z.infer<typeof WorkspaceUnregisterParamsSchema>;

export const WorkspaceUnregisterResultSchema = z.object({ ok: z.boolean() });
export type WorkspaceUnregisterResult = z.infer<typeof WorkspaceUnregisterResultSchema>;

// `worktree.remove` (Phase C, new-session-from-web redesign — see
// `packages/web/src/features/session-list/inline-spawn.ts`'s own header
// comment: every session from the workspace-row `+` flow now creates a
// fresh `.worktrees/<branch>` directory, and this codebase has no cleanup
// lifecycle at all — `.worktrees/` dirs and branches accumulate forever).
// A manual "clean up this session's worktree" action, deliberately never
// automatic (no cleanup-on-session-end: the user may still want to work in
// that worktree after the session ends). `worktree` is the exact linked
// worktree directory to remove — for a session spawned via this flow
// that's the session's own `workspaceId` (`commands/start.ts` registers
// the CHILD process's cwd, which for a worktree-mode spawn IS the worktree
// itself, as its own workspace entry — distinct from its parent repo's
// entry, which is what makes the worktree path independently resolvable
// and safe to target here without needing a second, separate field).
//
// `force` mirrors `git worktree remove`'s own semantics honestly rather
// than picking a default for the caller: a plain `git worktree remove`
// refuses (leaving the worktree untouched) when it contains uncommitted or
// untracked changes, and the daemon's handler (`worktreeRemove.ts`) surfaces
// that refusal back as `requiresForce` rather than silently discarding the
// work OR silently failing with a bare git error — the caller re-confirms
// with the user and retries with `force: true` (same two-step shape as the
// `create-directory`/`register-workspace` approval loops `spawn` already
// uses). `deleteBranch` is a SEPARATE, additive destructive step — deleting
// a branch is harder to reverse than removing a worktree directory, so it's
// never implied by `force` alone; `branchDeleted` in the result reports
// whether it actually happened (a branch-delete failure after a successful
// worktree removal does not fail the whole call — the safe part already
// succeeded).
export const WorktreeRemoveParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
  force: z.boolean().optional(),
  deleteBranch: z.boolean().optional(),
});
export type WorktreeRemoveParams = z.infer<typeof WorktreeRemoveParamsSchema>;

export const WorktreeRemoveResultSchema = z.object({
  removed: z.boolean(),
  /** `true` only when `removed` is `false` because `git worktree remove` refused over uncommitted/untracked changes — the caller should confirm with the user and retry with `force: true`. Any other failure throws instead (a genuinely unauthorized/not-a-worktree/git-error case), same as `spawn`'s `requiresApproval` vs. throw split. */
  requiresForce: z.boolean().optional(),
  /** Set (to `true` or `false`) only when `deleteBranch` was requested and the worktree was actually removed — omitted otherwise. */
  branchDeleted: z.boolean().optional(),
});
export type WorktreeRemoveResult = z.infer<typeof WorktreeRemoveResultSchema>;

export const AdoptListParamsSchema = z.object({
  idempotencyKey: z.string(),
  workspaceId: z.string(),
});

export const ProviderSessionSummarySchema = z.object({
  providerSessionId: z.string(),
  title: z.string().optional(),
  lastActivityAt: z.number(),
  running: z.boolean().optional(),
});
export type ProviderSessionSummary = z.infer<typeof ProviderSessionSummarySchema>;

export const AdoptListResultSchema = z.object({
  items: z.array(ProviderSessionSummarySchema),
});

export const AdoptTakeParamsSchema = z.object({
  idempotencyKey: z.string(),
  providerSessionId: z.string(),
  mode: z.enum(["takeover", "fork"]),
});

// `warning` is set when a 'takeover' actually interrupted a live, mid-turn
// process (design §10.4/FR-9.3: "if the process is mid-turn, show a
// warning") — additive field, absent on 'fork' or when the original process
// was already idle/finished.
export const AdoptTakeResultSchema = z.object({
  sessionId: z.string(),
  warning: z.string().optional(),
});
export type AdoptTakeResult = z.infer<typeof AdoptTakeResultSchema>;
export type AdoptTakeParams = z.infer<typeof AdoptTakeParamsSchema>;

// Read-only transcript mirror (design §4.4 "payload size rule" / §8 /
// plan.md §16 "3.3 Session adoption (UC9)"): serves an unmanaged session's
// transcript on demand in ≤64KB chunks rather than uploading whole
// histories eagerly. `cursor`/`nextCursor` are byte offsets into the
// transcript file; `done: true` on the final chunk (`nextCursor: null`).
// `blobRef` is a reserved extension point for the eventual blob-storage
// fallback for very large transcripts (plan.md §16 "4.3 Distribution &
// self-host") — unset until that subsystem lands, same as `git.diff`/
// `fs.read`'s own not-yet-wired `blobRef`.
export const AdoptMirrorParamsSchema = z.object({
  idempotencyKey: z.string(),
  providerSessionId: z.string(),
  cursor: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().positive().optional(),
});
export type AdoptMirrorParams = z.infer<typeof AdoptMirrorParamsSchema>;

export const AdoptMirrorResultSchema = z.object({
  chunk: z.string(),
  nextCursor: z.number().int().nonnegative().nullable(),
  done: z.boolean(),
  blobRef: z.string().optional(),
});
export type AdoptMirrorResult = z.infer<typeof AdoptMirrorResultSchema>;

// `sleepInhibit.get`/`sleepInhibit.set` machine RPCs (docs/features/
// sleep-inhibit.md, docs/competitive-notes-omnara.md #12 "Sleep-inhibit
// control"): a per-machine tri-state policy that makes the daemon hold an
// OS "don't sleep" assertion via `caffeinate` (macOS only for MVP) so a Mac
// won't sleep mid-session. `"off"` holds no assertion; `"onPower"` maps to
// `caffeinate -s` (system-sleep prevention, but macOS itself only honors
// `-s` while on AC power — no battery polling needed daemon-side);
// `"always"` maps to `caffeinate -i` (idle-sleep prevention regardless of
// power source). Both flags are always paired with `-w <daemon pid>`
// (`daemon/sleepInhibit.ts`) so the OS itself releases the assertion the
// instant the daemon process exits — the leak-safety guard, in place of any
// `doctor`/`markers` reaping. `idempotencyKey` is carried for family
// uniformity only (this module's header comment): `get` is a pure read,
// `set` is naturally idempotent (applying the same mode twice converges to
// the same single child), same rationale as `provider.account`/`git.status`.
export const SleepInhibitModeSchema = z.enum(["off", "onPower", "always"]);
export type SleepInhibitMode = z.infer<typeof SleepInhibitModeSchema>;

// Shared result shape for BOTH RPCs — `set` returns the post-apply state so
// the caller needs no follow-up `get`. `supported: false` is the honest
// answer on any non-darwin `platform` (the RPC never spawns a real
// assertion there, and `mode`/`active` are reported as `"off"`/`false`
// regardless of the requested mode). `active` reports whether a caffeinate
// child is currently live — `false` when `mode` is `"off"`, when
// unsupported, or when the child failed to spawn (a Mac missing
// `/usr/bin/caffeinate` is broken-but-survivable, never thrown).
export const SleepInhibitStateSchema = z.object({
  supported: z.boolean(),
  platform: z.string(),
  mode: SleepInhibitModeSchema,
  active: z.boolean(),
});
export type SleepInhibitState = z.infer<typeof SleepInhibitStateSchema>;

export const SleepInhibitGetParamsSchema = z.object({
  idempotencyKey: z.string(),
});
export type SleepInhibitGetParams = z.infer<typeof SleepInhibitGetParamsSchema>;

export const SleepInhibitSetParamsSchema = z.object({
  idempotencyKey: z.string(),
  mode: SleepInhibitModeSchema,
});
export type SleepInhibitSetParams = z.infer<typeof SleepInhibitSetParamsSchema>;

// ---------------------------------------------------------------------------
// Session RPCs — registered by the session process (design §4.4)
// ---------------------------------------------------------------------------

export const MessageRpcParamsSchema = z.object({ envelope: SessionEnvelopeSchema });

// Tri-state reply (design §7.10 "Send-idempotency claim", v0.3): protects
// the highest-frequency mutating session RPC end-to-end — a retried or
// duplicated `message` call must never cause the agent to run a turn twice.
// - 'queued': normal accept path (today's only outcome).
// - 'duplicate': a claim for this envelope id already recorded a terminal
//   result — this call is a replay; the caller reconciles as success.
// - 'outcome-unknown': a claim for this envelope id exists with no recorded
//   result (crash mid-turn — the prompt may have partially run). The caller
//   MUST NOT re-execute: reconcile from the transcript instead.
export const MessageRpcStatusSchema = z.enum(["queued", "duplicate", "outcome-unknown"]);
export type MessageRpcStatus = z.infer<typeof MessageRpcStatusSchema>;

// `queued` (unchanged, required) stays exactly as it shipped — the
// additive-only wire policy (design §5.3) forbids retyping an
// already-shipped required field, and the CLI's `message` RPC handler
// (packages/cli/src/commands/start.ts) still only ever sets it: wiring the
// send-idempotency claim store into `deliverMessage()` so the producer can
// actually compute `status` is Phase 2.2 (plan.md §17 "17. v2 — ACP
// migration"), not this change. `status` is therefore additive *and*
// optional — a reply that omits it (every producer today) is still valid,
// and the web composer falls back to the pre-existing `queued`-only
// behavior when it's absent (`optimistic-composer.ts`).
export const MessageRpcResultSchema = z.object({
  queued: z.boolean(),
  status: MessageRpcStatusSchema.optional(),
});

export const PermAnswerParamsSchema = z.object({
  reqId: z.string(),
  decision: PermDecisionSchema,
});

// First-wins across devices (design §7.6): the session process resolves each
// reqId exactly once. The losing answer gets ok:false plus the decision that
// actually won, so the client can render "answered on another device".
// `"local-turn"` (no `decision` — nobody has answered yet) is the other
// ok:false case: the reqId belongs to a locally-typed terminal turn, which
// has no channel for a web click to drive Claude Code's own live dialog
// (packages/cli/src/claude/pretoolPermissionBridge.ts's `resolve()`). Kept as
// a multi-value `z.literal` (not `z.enum`) so the wire additive-only compat
// check still sees this as a widened literal, not a retyped field.
export const PermAnswerResultSchema = z.object({
  ok: z.boolean(),
  reason: z.literal(["already-answered", "local-turn"]).optional(),
  decision: PermDecisionSchema.optional(),
});

export const InterruptParamsSchema = z.object({});
export const InterruptResultSchema = z.object({ ok: z.boolean() });

// `stop` (plan.md §16 "2.3 Stop session", plan-v2.md W2.3 "Stop session from
// the web"): a session RPC, not the machine RPC `StopSessionParams/
// ResultSchema` above — the session process is alive, connected, and owns
// its own child, so no daemon round-trip is needed (the daemon doesn't even
// track terminal sessions, design §A9). The machine-RPC `stopSession` stays
// reserved for a dead/daemon-spawned session with no live session-RPC
// target to call directly (plan-v2.md Wave 4 note).
export const StopRpcParamsSchema = z.object({
  /** Graceful by default (SIGTERM to the child, or the remote loop's own
   * exit request); `force: true` additionally exits the whole CLI process
   * after a short grace period even if the child hasn't exited yet. */
  force: z.boolean().optional(),
});
export const StopRpcResultSchema = z.object({ ok: z.boolean() });

export const TakeControlParamsSchema = z.object({});
export const TakeControlResultSchema = z.object({ ok: z.boolean() });

export const SetModeParamsSchema = z.object({ mode: PermissionModeSchema });
export const SetModeResultSchema = z.object({
  ok: z.boolean(),
  // Additive (plan-v2.md W4.3 "Real setMode for the PTY path"): the PTY
  // path can't blindly trust its own Shift+Tab keystrokes landed — it
  // verifies via the next hook input's `permission_mode` echo and reports
  // whatever it actually observed here, so the caller can revert an
  // optimistic UI update to the true mode on a failed/unverified switch.
  // Absent from the remote-loop path (its `setMode` is a real, synchronous
  // ACP call with no separate echo to report) — `ok` alone stays authoritative there.
  observedMode: PermissionModeSchema.optional(),
});

/**
 * Curated `/model` aliases the CLI's PTY injection path is allowed to type
 * into a live terminal (docs/known-issues.md issue #12, "web model
 * selector") — a closed enum, not a free `z.string()` like
 * `SpawnParamsSchema.model` above. That field only ever becomes a
 * `--model` CLI flag argument, never raw keystrokes, so an arbitrary string
 * is safe there. This one is typed character-for-character into a live PTY
 * (`ptyClaudeSession.ts`'s `sendModelChange`), so an arbitrary string here
 * would be a keystroke-injection vector (e.g. an embedded "\r" could submit
 * a second, attacker-chosen command as if typed at the terminal) — the
 * server-side wire validation on this schema IS the enforcement point, not
 * just a CLI-side convention. Mirrors the aliases
 * `packages/web/src/features/new-session/model-meta.ts` already curates for
 * spawn time — those resolve against `claude`'s own `--model` flag, and the
 * same short names are what its live `/model` slash command accepts.
 */
export const RUNNING_SESSION_MODEL_ALIASES = [
  "sonnet",
  "opus",
  "haiku",
  "sonnet[1m]",
  "opus[1m]",
] as const;
export type RunningSessionModelAlias = (typeof RUNNING_SESSION_MODEL_ALIASES)[number];

export const SetModelParamsSchema = z.object({
  model: z.enum(RUNNING_SESSION_MODEL_ALIASES),
});
export const SetModelResultSchema = z.object({
  ok: z.boolean(),
  // Additive, mirrors `SetModeResultSchema.observedMode` above: the PTY
  // path can't blindly trust its own `/model` keystrokes landed as a real
  // switch. It verifies via the next transcript "Set model to ..." echo
  // (`claude/modelChange.ts`) and reports whatever it actually parsed here
  // — free text (e.g. "Sonnet 5" for a requested "sonnet", Claude Code's
  // own display name, not necessarily string-equal to the request) rather
  // than the closed alias enum `model` above uses — so the caller can
  // revert an optimistic UI update to the true state on a failed/unverified
  // switch. There is no dedicated hook field for "current model" the way
  // `permission_mode` exists for mode, so this echo is inherently a looser
  // signal than `SetModeResultSchema.observedMode`'s hook-sourced one.
  observedModel: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Per-workspace Setup/Run scripts (docs/features/setup-run-scripts.md,
// docs/competitive-notes-omnara.md #7): a persisted "Setup script" (runs
// once per freshly-created worktree, e.g. `npm install`) and "Run script"
// (a one-click, long-lived dev-server-style process, e.g. `npm run dev`),
// both defined CLI-only (`kvy workspace config --setup-script/
// --run-script`, design §12's local-consent boundary — no RPC params
// schema below ever carries a script string, only a `worktree` path the
// daemon resolves back to its own on-disk config). `workspace.getConfig` is
// the one read-only addition that lets the web Workspace Settings UI *see*
// the configured scripts; `run.*` is the new long-lived run-process
// subsystem, deliberately decoupled from the reserved (and still unbuilt)
// `preview:*` tunnel namespace (`reserved.ts`).
// ---------------------------------------------------------------------------

export const WorkspaceGetConfigParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
});
export type WorkspaceGetConfigParams = z.infer<typeof WorkspaceGetConfigParamsSchema>;

export const WorkspaceGetConfigResultSchema = z.object({
  baseRef: z.string().optional(),
  remote: z.string().optional(),
  setupScript: z.string().optional(),
  runScript: z.string().optional(),
});
export type WorkspaceGetConfigResult = z.infer<typeof WorkspaceGetConfigResultSchema>;

// `workspace.setConfig`: the web Workspace Settings UI's write path for
// `baseRef`/`remote` only — `setupScript`/`runScript` stay outside this
// schema entirely, preserving design §12's local-consent boundary (no
// script string ever crosses the RPC wire in either direction). `baseRef`/
// `remote` carry no execution risk, so unlike scripts they're safe to set
// remotely; an empty string clears the field, matching
// `setWorkspaceGitConfig`'s clear-on-empty-string semantics.
export const WorkspaceSetConfigParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
  baseRef: z.string().optional(),
  remote: z.string().optional(),
});
export type WorkspaceSetConfigParams = z.infer<typeof WorkspaceSetConfigParamsSchema>;

export const WorkspaceSetConfigResultSchema = z.object({
  baseRef: z.string().optional(),
  remote: z.string().optional(),
});
export type WorkspaceSetConfigResult = z.infer<typeof WorkspaceSetConfigResultSchema>;

// `run.start`/`run.stop`/`run.status`/`run.setup` (docs/features/
// setup-run-scripts.md Phase 3): the daemon's long-lived run-process
// subsystem. `worktree` resolves (via the registered-workspace authorizer,
// same as `git.commit`/`git.push`/`git.renameBranch`) to the containing
// workspace whose `runScript`/`setupScript` config applies — a
// `.worktrees/<branch>` directory is never itself a config key.
export const RunStartParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
});
export type RunStartParams = z.infer<typeof RunStartParamsSchema>;

export const RunStartResultSchema = z.object({
  started: z.boolean(),
  alreadyRunning: z.boolean().optional(),
  method: z.enum(["tmux", "detached"]).optional(),
  pid: z.number().optional(),
  tmuxSessionName: z.string().optional(),
});
export type RunStartResult = z.infer<typeof RunStartResultSchema>;

export const RunStopParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
});
export type RunStopParams = z.infer<typeof RunStopParamsSchema>;

export const RunStopResultSchema = z.object({
  stopped: z.boolean(),
  wasRunning: z.boolean(),
});
export type RunStopResult = z.infer<typeof RunStopResultSchema>;

export const RunStatusParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
});
export type RunStatusParams = z.infer<typeof RunStatusParamsSchema>;

// `run`/`setup` are each reported independently — a run-script process can
// be live while a setup re-run is in flight (e.g. "Re-run setup" while the
// dev server is still up from before). `logTail` is the last few KB of the
// respective log file (`run-<hash>.log`/`setup-<hash>.log`), read tolerant
// of a missing file (nothing has ever run yet) — same "no blob subsystem
// yet, inline only" contract as `git.diff`'s `inline`/`truncated` fields,
// just without a `truncated` flag since a tail is deliberately partial by
// design, not by a size cutoff being hit.
export const RunStatusResultSchema = z.object({
  run: z.object({
    state: z.enum(["running", "stopped", "none"]),
    pid: z.number().optional(),
    method: z.enum(["tmux", "detached"]).optional(),
    startedAt: z.number().optional(),
    logTail: z.string().optional(),
  }),
  setup: z.object({
    state: z.enum(["not-run", "running", "succeeded", "failed"]),
    exitCode: z.number().optional(),
    startedAt: z.number().optional(),
    finishedAt: z.number().optional(),
    logTail: z.string().optional(),
  }),
});
export type RunStatusResult = z.infer<typeof RunStatusResultSchema>;

export const RunSetupParamsSchema = z.object({
  idempotencyKey: z.string(),
  worktree: z.string(),
});
export type RunSetupParams = z.infer<typeof RunSetupParamsSchema>;

export const RunSetupResultSchema = z.object({
  started: z.boolean(),
  alreadyRunning: z.boolean().optional(),
});
export type RunSetupResult = z.infer<typeof RunSetupResultSchema>;
