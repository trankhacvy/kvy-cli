# Falcon

pnpm + Turborepo monorepo. This file documents commands and conventions only —
for the "why", read `plan.md` (build plan + phase-by-phase TODO), `falcon-system-design.md`
(architecture/protocol design), and `falcon-prd.md` (product requirements).

## Commands

Run from repo root (Turborepo resolves per-package task graphs via `dependsOn`):

```bash
pnpm install       # installs deps; postinstall builds @falcon/wire first
pnpm build         # turbo run build     — dual CJS/ESM builds via pkgroll (web: `next build` → static out/)
pnpm typecheck     # turbo run typecheck — tsc --noEmit, depends on ^build
pnpm test          # turbo run test      — vitest run, depends on build
pnpm lint          # biome check . (auto-retries once on failure — see note below)
pnpm lint:fix       # biome check --write .
```

`pnpm lint` retries once automatically: running it immediately after `pnpm build`/`pnpm test`
can occasionally hit `[warn] Linter process terminated abnormally (possibly out of memory)`
from transient resource contention (biome daemon warm-up racing the tail end of `next build`/
vitest CPU usage), not a config problem — `.next`/`out` are already excluded in `biome.json`.
The retry absorbs that transient failure; a lint run that fails twice in a row is a real issue.

Scope to one package with `--filter`, e.g. `pnpm --filter @falcon/wire build`.

CI (`.github/workflows/ci.yml`) runs, in order: install (frozen lockfile) → lint →
build `@falcon/wire` → typecheck → test.

## Package layout

```
packages/
├─ wire/      @falcon/wire    Zod schemas — shared wire protocol contract.
├─ crypto/    @falcon/crypto  E2E encryption primitives (node + browser).
├─ cli/       falcon          CLI + daemon + ACP adapter + git/workspace/github/preview subsystems.
├─ server/    @falcon/server  Fastify server, Postgres, Socket.IO, auth, push dispatch.
└─ web/       @falcon/web     Next.js PWA — home, session timeline, git, checks, preview, settings.
```

**For detailed internals of each package, see `docs/packages-guide.md`.**

Each package builds with `pkgroll` to dual CJS/ESM + `.d.ts`, and exposes
`build` / `typecheck` / `test` scripts consumed by the root turbo pipeline.

## Database (`packages/server`)

Drizzle ORM + Postgres. Schema lives in `packages/server/src/db/schema.ts`; every
encrypted column uses the shared `bytea` custom type (raw ciphertext bytes, never
decrypted server-side — design §5.3/§6.1). `DATABASE_URL` config env var, defaults to
`postgres://falcon:falcon@localhost:5432/falcon` for local dev.

```bash
pnpm --filter @falcon/server db:generate   # drizzle-kit generate — diff schema.ts, emit drizzle/*.sql
pnpm --filter @falcon/server db:migrate    # apply pending migrations once, standalone
```

Migrations also run automatically on server boot (`src/db/migrate.ts`, called from
`main.ts` before `app.listen` — design §6.5: "migrate runs on boot"). Idempotent: safe
to run against an already-current database.

## Local dev stack

Run the three processes locally (each in its own long-lived shell / tmux pane):

```bash
# 0. Postgres must be up at postgres://falcon:falcon@localhost:5432/falcon (see Database above).
pnpm --filter @falcon/server dev   # Fastify API on :3005 (tsx watch; migrates on boot)
pnpm --filter @falcon/web dev      # Next.js web on :3000 (defaults its API to http://localhost:3005)
```

The **CLI** defaults to the production deployment (`api.falcon.dev` / `app.falcon.dev`),
so point it at your local stack with two env vars (`packages/cli/src/auth/config.ts`):

```bash
export FALCON_BACKEND_URL=http://localhost:3005
export FALCON_FRONTEND_URL=http://localhost:3000
# optional: isolate CLI state (token, daemon, sessions) from your real ~/.falcon
export FALCON_HOME_DIR=/tmp/falcon-e2e
pnpm --filter falcon dev -- claude --model haiku   # runs `falcon claude …` via tsx (no build needed)
```

`falcon` == `falcon claude [args…]`; flags pass straight through to Claude Code, so
`--model haiku` selects the model (`extractModelFlag`, `commands/start.ts`).

## Auth model (post issue-4) — what a test account needs

Identity and the encryption key are **separate** now (see `docs/issue-4-plan.md`):

- **Identity** = email+password (or Google/GitHub). Sessions are long-lived: a short access
  token (15 min) auto-refreshed by a rotating refresh token; revocable per device.
- **Key custody** = a client-held `masterSecret`, **PIN-wrapped at rest** (web: in the crypto
  worker + IndexedDB; CLI: `~/.falcon/access.key`). The PIN unlocks it; a browser **reload
  clears the worker, so the PIN is prompted again** — that's expected, test it.
- **Losing the PIN loses encrypted sessions, not the account** — the user can start a fresh
  key epoch (old E2E data becomes "archived", account/identity survive).
- New devices get the key via **pairing** (`falcon auth login` → approve in an already-signed-in
  browser), never by copying a secret. There is no recovery code anymore.

Dev DBs are disposable — a reset DB has no accounts, so **re-register** each time.
For email/password tests you do **not** need any OAuth app configured.

## Testing the app end-to-end (runbook for an agent)

Use **tmux** to drive the CLI (a real Claude Code TUI — keep it on **haiku** to stay cheap)
and the **Chrome MCP tools** to drive the web. Load the Chrome tools first with one
ToolSearch (`select:mcp__claude-in-chrome__tabs_context_mcp,…navigate,…computer,…read_page,…tabs_create_mcp,…form_input,…read_console_messages`).

1. **Stack up:** Postgres running; `@falcon/server` dev on :3005 and `@falcon/web` dev on :3000
   in tmux panes (or background). If ports clash with another worktree, pick free ones and set
   `PORT`/`NEXT_PUBLIC_API_URL`/`FALCON_BACKEND_URL` to match — never blanket-kill by process name.
2. **Prepare the account (Chrome MCP):** open `http://localhost:3000` → it redirects to `/signin/`
   → go to `/password/` → **Sign up** with a throwaway email + password, then **set a PIN**
   (use a fixed test PIN, e.g. `123456`, and remember it). This registers the account, generates
   the `masterSecret`, PIN-wraps it, and binds the key epoch — you land authenticated.
3. **Pair the CLI (tmux):** with the env vars above, run `falcon auth login`. It prints a pairing
   URL/QR — open that URL in the already-signed-in Chrome tab and **approve**. The CLI now holds a
   real refresh token + the sealed `masterSecret`; check with `falcon auth status`.
4. **Start a session (tmux):** in a project dir, `falcon claude --model haiku`. The daemon
   auto-starts, registers the machine, and mirrors the (encrypted) transcript.
5. **Verify (Chrome MCP):** the session appears on Home; open its timeline. Exercise the auth
   surface specifically: **reload → PIN unlock keeps you in** (silent refresh, no `/signin/`
   bounce); Settings → **Devices** lists sessions and "log out other devices" drops the revoked
   session's socket immediately; wrong-password lockout after repeated attempts.

Process hygiene: only manage processes you started, verify a PID's cwd before killing it, and
prefer non-default ports when another worktree may be running its own stack.

## Conventions

- **pnpm workspaces** — `pnpm-workspace.yaml` globs `packages/*`. Add new packages there;
  no other wiring needed for pnpm to pick them up.
- **Strict TypeScript** — every package extends root `tsconfig.base.json` (strict mode,
  `noUncheckedIndexedAccess`, `noImplicitReturns`, etc.). Don't loosen these per-package.
- **`@/` path alias** — each package's own `tsconfig.json` maps `@/*` to `./src/*`. Import
  within a package via `@/...`; import across packages via the published package name
  (e.g. `@falcon/wire`).
- **Biome** — single formatter + linter at the root (`biome.json`), not per-package. Run
  `pnpm lint` / `pnpm lint:fix` before committing.
- **`@falcon/wire` builds first** — it has no workspace dependencies and everything else
  depends on its compiled output; this is why CI and `postinstall` (`scripts/postinstall.cjs`,
  skippable via `SKIP_FALCON_WIRE_BUILD=1`) build it explicitly ahead of the general build.

## Docs

- `plan.md` — the build plan and the authoritative phase/task checklist (§16).
- `falcon-system-design.md` — architecture, protocol, and encryption design.
- `falcon-prd.md` — product requirements.
- `docs/protocol.md`, `docs/encryption.md` — short stubs pointing into the design doc.
- `docs/uninstall.md` — user-facing uninstall/cleanup guide: `falcon shim uninstall`,
  `falcon daemon service uninstall`, and the full `rm -rf ~/.falcon` walkthrough
  (falcon-prd.md FR-1.6).
- `deploy/README.md` — self-host walkthrough (`deploy/docker-compose.yml`: server +
  postgres + optional minio, migrate-on-boot, split-origin web with strict CSP + SRI).

Update this file as each phase lands new packages (e.g. once `cli`/`server`/`web` exist,
move them out of "planned" above and add any new root-level commands they introduce).
