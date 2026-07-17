# Continuation brief: evaluate/adopt ACP for Falcon

Paste this whole file as your first message in the new session.

---

You're continuing work on **Falcon**, a pnpm+Turborepo monorepo at
`/Users/trankhacvy/Desktop/MyCave/vibecode/misc/vibe-ide` (E2E-encrypted "mission control"
for coding-agent sessions — wraps Claude Code / Codex, mirrors sessions to a web/mobile
dashboard, lets you steer them remotely). Read `CLAUDE.md` first for the full package layout
and commands, then `plan.md` (build plan, §16 is the detailed task checklist) and
`falcon-system-design.md` (current architecture) to ground yourself in what actually exists
today — don't rely on this brief for implementation details, only for the *narrative* of how
we got here and what to do next.

## Current state (as of this brief)

All 5 packages (`wire`, `crypto`, `server`, `cli`, `web`) build/typecheck/test green.
`plan.md`'s §16 checklist is ~98% checked off. The system works end-to-end: `falcon auth
login` pairs a CLI to an account, `falcon claude` spawns a real local Claude Code session,
it mirrors live to the web timeline, sending a message from the web switches the session
into SDK-driven remote mode and the reply streams back to both web and terminal.

## This session's bug-fix saga (context — don't rediscover or accidentally revert these)

A `falcon-dev-loop` multi-agent workflow (`.claude/workflows/falcon-dev-workflow.js`) did
most of the implementation across many parallel-agent cycles. Individual pieces were built
and unit-tested in isolation but several were never actually wired into the real entrypoints
— that was the dominant bug class this session, found one at a time by manually testing the
tool end-to-end:

1. **The dev-loop workflow itself had a bug**: its Verification/Cleanup phases were dead-code
   stubs (logged "merging..." but never ran `git merge`), so tasks got silently re-queued and
   re-implemented from scratch across cycles. Fixed in the workflow script (real git
   merge/cleanup via agent-driven bash, anti-duplication check in task discovery).
2. **`falcon claude` was an honest stub** (`index.ts`'s `describeStart`) — wired real session
   bootstrap → outbox → mode loop in `packages/cli/src/commands/start.ts`.
3. **Pairing flow had two bugs**: the web `/pair` page decoded the CLI's base64url URL
   fragment as plain base64 (silently mis-decoded), and separately the CLI's `pair.ts` never
   stripped the 1-byte version prefix the web worker's sealed payload carries. Both fixed.
4. **Claude Code ≥2.1.113 ships a native binary, not `cli.js`** — the launcher script
   (`falcon_claude_launcher.cjs`) only knew how to `import()` a JS file. Added a
   `spawnSync`-based binary-spawn path.
5. **The shell shim (`falcon shim install`) broke `falcon claude` for itself**: the CLI's own
   `findClaudeInPath()` locator found `~/.falcon/bin/claude` (the shim, which `exec`s
   `falcon claude`) instead of skipping past it to the real binary. Fixed to skip Falcon's
   own shim directory.
6. **Remote-mode had no terminal UI**: `RemoteModeDisplay` (an Ink component) was fully built
   and tested but `claudeRemoteLauncher.ts` never actually called Ink's `render()` on it.
   Ported `terminalStdinCleanup.ts` verbatim from Happy (the reference codebase — see below)
   and wired the full render/raw-mode/unmount lifecycle, matching Happy's own
   `claudeRemoteLauncher.ts` exactly.
7. **Messages sent from the web displayed duplicated / out of order**: the web Composer's
   optimistic insert is reconciled against the real transcript by matching envelope **id**
   (`optimistic-composer.ts`'s `reconcilePending`) — but the id got dropped in
   `claudeRemoteLauncher.ts`'s `deliverMessage()` → `claudeRemote.ts`'s `send()`, which always
   minted a fresh id. Fixed by threading the id through `send(prompt, id?)`, plus added a
   content-based `(role, text)` fallback match in `reconcilePending` as defense-in-depth
   (see the Omnara comparison below for why).

All of the above have tests and are rebuilt into `packages/cli/dist/`. **If `falcon claude` /
the web UI misbehaves again in a way that looks like one of these, check whether `dist/` is
stale before assuming it's a new bug** — `bin/falcon.mjs` runs the built bundle, not source;
`pnpm --filter falcon build` after every CLI source change.

## Local dev environment already set up

- Postgres: Docker container `falcon-postgres`, port **5433** (5432 is taken by a native
  Postgres install on this machine) — `postgres://falcon:falcon@localhost:5433/falcon`.
- Server: `DATABASE_URL=postgres://falcon:falcon@localhost:5433/falcon FALCON_DEV_AUTH=1
  pnpm --filter @falcon/server dev` → `:3005`.
- Web: `NEXT_PUBLIC_FALCON_DEV_AUTH=1 pnpm --filter @falcon/web dev` → `:3000`.
- `FALCON_DEV_AUTH=1` / `NEXT_PUBLIC_FALCON_DEV_AUTH=1` is a dev-only fake-auth path built
  this session (a "Continue without OAuth (dev only)" button on `/signin`) — hard-gated so
  `NODE_ENV=production` + this flag refuses to boot. Use it instead of setting up real
  Google/GitHub OAuth apps for local testing.
- CLI: `FALCON_BACKEND_URL=http://localhost:3005 FALCON_FRONTEND_URL=http://localhost:3000
  node packages/cli/bin/falcon.mjs claude` (run `auth login` first). Shell shim is installed
  at `~/.falcon/bin/{claude,codex}`.
- Known flake: `next dev`'s HMR cache occasionally corrupts after many edits ("Cannot read
  properties of undefined (reading 'call')" or similar webpack errors). Fix: `pkill -f "next
  dev"; rm -rf packages/web/.next`, then restart.

## Reference codebases cloned at repo root (gitignored — read-only, for porting/comparison)

- **`happy/`** — MIT, the primary reference `plan.md`/`falcon-system-design.md` were built
  against. Falcon ports large chunks of this verbatim/adapted (crypto, RPC handler, pairing
  flow, etc.) — check here first whenever something in Falcon looks incomplete, since Happy
  usually already solved it correctly.
- **`superset/`** — another reference, less explored this session.
- **`omnara/`** — Python, PTY-wraps the Claude Code CLI directly (one long-lived process,
  both local keystrokes and web-originated text injected into the same PTY stdin). Its
  `MessageProcessor.web_ui_messages` is a plain content-based `set()` for recognizing "this
  transcript line is the echo of what I just injected" — structurally immune to the id-drop
  bug class in #7 above, at the cost of parsing rendered terminal output (regex) for
  permission prompts instead of a structured SDK hook.
- **`mobvibe/`** — TypeScript, uses **ACP (Agent Client Protocol)** instead of PTY-wrapping or
  SDK-querying. This is what motivates the rest of this brief.

## The actual task: evaluate (and likely adopt) ACP for Falcon

The user's direction, verbatim intent: **not just bug-fixing** — willing to change Falcon's
system design if it makes the tool stronger and more stable. Specifically interested in
replacing (or augmenting) the current dual-mode design —
`packages/cli/src/claude/claudeLocal.ts` + `falcon_claude_launcher.cjs` (local child-process
spawn, `stdio: inherit`) plus `packages/cli/src/remote/claudeRemote.ts` (Claude Agent SDK
`query()` for remote mode) plus `loop.ts` (the state machine switching between them) — with
an ACP-based integration, informed by how `mobvibe/apps/mobvibe-cli/src/acp/` does it.

### What's already known about mobvibe's design (from this session's research — verify/deepen, don't just trust this)

- `apps/mobvibe-cli/src/acp/acp-connection.ts` + `session-manager.ts` are the ACP integration
  layer — **not read in depth yet**. Read these first, in full.
- A local SQLite **WAL** (`apps/mobvibe-cli/src/wal/{wal-store,seq-generator,consolidator,
  compactor,migrations}.ts`) is the durable event log, with `revision`/`seq` cursors for
  backfill/reconnection — more rigorous than Falcon's current `sessions.msgSeq` + disk-backed
  HTTP outbox.
- A real **send-time idempotency claim** exists and Falcon doesn't have an equivalent:
  `wal-store.ts`'s `claimMessageSend(sessionId, messageId)` / `completeMessageSend(...)` —
  atomic SQLite-transaction claim-before-execute, so a retried/duplicated `message` RPC can
  never cause the agent to be invoked twice for one logical send. Falcon's `sessionRpc.ts`
  `message` handler has **zero** protection against this today (only the display-layer
  dedup from bug #7 above exists — that stops it from being *shown* twice, not from actually
  running twice). This is worth adopting regardless of the ACP decision.
- Architecture is explicitly documented (`.planning/codebase/ARCHITECTURE.md` in that repo)
  as "gateway is ephemeral/stateless-ish, CLI-local WAL is the durable source of truth" — the
  same split Falcon already has conceptually, just less rigorously enforced.

### Suggested first steps (refine with the user, don't treat as fixed)

1. **Feasibility check first, before anything else**: does the currently-installed Claude
   Code CLI (and Codex CLI) actually expose an ACP server mode today? Check `claude --help`,
   Claude Code's own docs/changelog, and how `mobvibe/apps/mobvibe-cli/src/config.ts` spawns
   its configured agent processes (what command/flags does it actually invoke?). This
   determines whether ACP adoption is viable right now for both providers Falcon supports, one
   of them, or neither yet — don't assume; verify directly.
2. Read `mobvibe/apps/mobvibe-cli/src/acp/acp-connection.ts` and `session-manager.ts` in full.
3. Read `mobvibe/apps/mobvibe-cli/src/wal/*` in full, plus `apps/gateway/src/services/
   message-send-safety.ts`, as the reference design for durability + send idempotency.
4. Re-read Falcon's own `falcon-system-design.md` and the relevant parts of `plan.md`
   (§6 CLI, §7 daemon) to ground the comparison in what Falcon actually has today.
5. Write a concrete delta proposal — mirror the style `plan.md` already uses for "deltas from
   Happy" (a table: what Happy does vs. what Falcon does, and why). Do the same for "deltas
   from adopting ACP": what gets replaced, what stays, whether ACP's event model maps cleanly
   onto Falcon's existing `SessionEnvelope`/`@falcon/wire` schema (it likely can — that schema
   is provider-agnostic by design) or needs to change, and the migration/rollback risk given
   the tool is ~98% functionally complete and working end-to-end today.
6. **Get explicit user sign-off on the written proposal before writing implementation code.**
   This is a core-architecture change to something that currently works — use plan mode (or
   equivalent) rather than diving straight into edits. Don't over-scope: an ACP swap likely
   only touches the CLI's provider-communication layer (`claude/`, `remote/`, the launcher
   script, `envelopeMapper.ts`/`sdkToEnvelope.ts`) — the wire protocol, server, crypto, and
   web layers probably don't need to change if ACP's events map onto the existing envelope
   schema. Confirm that scoping in the proposal rather than assuming a full rewrite.
