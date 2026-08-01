# Kvy

pnpm + Turborepo monorepo. This file documents commands and conventions only —
for the "why", read `plan.md` (build plan + phase-by-phase TODO), `kvy-system-design.md`
(architecture/protocol design), and `kvy-prd.md` (product requirements).

## Commands

Run from repo root (Turborepo resolves per-package task graphs via `dependsOn`):

```bash
pnpm install       # installs deps; postinstall builds @kvy/wire first
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

Scope to one package with `--filter`, e.g. `pnpm --filter @kvy/wire build`.

CI (`.github/workflows/ci.yml`) runs, in order: install (frozen lockfile) → lint →
build `@kvy/wire` → typecheck → test.

## Package layout

```
packages/
├─ wire/      @kvy/wire    Zod schemas — shared wire protocol contract.
├─ crypto/    @kvy/crypto  E2E encryption primitives (node + browser).
├─ cli/       kvy          CLI + daemon + ACP adapter + git/workspace/github/preview subsystems.
├─ server/    @kvy/server  Fastify server, Postgres, Socket.IO, auth, push dispatch.
└─ web/       @kvy/web     Next.js PWA — home, session timeline, git, checks, preview, settings.
```

**For detailed internals of each package, see `docs/packages-guide.md`.**

Each package builds with `pkgroll` to dual CJS/ESM + `.d.ts`, and exposes
`build` / `typecheck` / `test` scripts consumed by the root turbo pipeline.

## Database (`packages/server`)

Drizzle ORM + Postgres. Schema lives in `packages/server/src/db/schema.ts`; every
encrypted column uses the shared `bytea` custom type (raw ciphertext bytes, never
decrypted server-side — design §5.3/§6.1). `DATABASE_URL` config env var, defaults to
`postgres://kvy:kvy@localhost:5432/kvy` for local dev — but this repo's
root `.env.local` currently points it at a hosted Neon Postgres instead, so **no
local/Docker Postgres is needed to run or test the stack**; only switch back to the
localhost default (and start Docker for it) if `.env.local`'s `DATABASE_URL` is
ever pointed back at `localhost`.

```bash
pnpm --filter @kvy/server db:generate   # drizzle-kit generate — diff schema.ts, emit drizzle/*.sql
pnpm --filter @kvy/server db:migrate    # apply pending migrations once, standalone
```

Migrations also run automatically on server boot (`src/db/migrate.ts`, called from
`main.ts` before `app.listen` — design §6.5: "migrate runs on boot"). Idempotent: safe
to run against an already-current database.

## Local dev stack

Run the two processes locally (each in its own long-lived shell / tmux pane) —
**no Docker needed**: `DATABASE_URL` in root `.env.local` points at a hosted Neon
Postgres (see Database above), not a local container.

```bash
pnpm --filter @kvy/server dev   # Fastify API on :3005 (tsx watch; migrates on boot)
pnpm --filter @kvy/web dev      # Next.js web on :3000 (defaults its API to http://localhost:3005)
```

The **CLI** defaults to the production deployment (`api.kvy.dev` / `app.kvy.dev`),
so point it at your local stack with two env vars (`packages/cli/src/auth/config.ts`):

```bash
export KVY_BACKEND_URL=http://localhost:3005
export KVY_FRONTEND_URL=http://localhost:3000
# optional: isolate CLI state (token, daemon, sessions) from your real ~/.kvy
export KVY_HOME_DIR=/tmp/kvy-e2e
pnpm --filter kvy dev -- claude --model haiku   # runs `kvy claude …` via tsx (no build needed)
```

`kvy` == `kvy claude [args…]`; flags pass straight through to Claude Code, so
`--model haiku` selects the model (`extractModelFlag`, `commands/start.ts`).

## Auth model (post issue-4) — what a test account needs

Identity and the encryption key are **separate** now (see `docs/issue-4-plan.md`):

- **Identity** = email+password (or Google/GitHub). Sessions are long-lived: a short access
  token (15 min) auto-refreshed by a rotating refresh token; revocable per device.
- **Key custody** = a client-held `masterSecret`, wrapped at rest (web: crypto worker +
  IndexedDB; CLI: `~/.kvy/access.key` under an OS-vault device key). **There is no PIN
  any more** — a browser reload loads the key with no prompt (`"device"` mode) or one
  biometric tap (`"prf"` mode, a passkey-derived wrap key). See
  docs/auth-ux-overhaul-plan.md Phase 5 for the honest threat table on that trade.
- **A browser with no keys is still signed in** — the refresh token lives in its own store
  (`crypto/session-storage.ts`), which is what lets it ask another device for a copy.
- New devices get the key two ways, never by copying a secret: **CLI pairing**
  (`kvy auth login` → approve in a signed-in browser) and **device-to-device key
  sharing** (a keyless browser asks; a holder approves after comparing a 6-digit code —
  in the browser, or via `kvy keys approve` on a machine that has the keys).
- **Losing every device that holds the keys loses encrypted sessions, not the account** —
  `/reset-keys/` starts a fresh key epoch (old E2E data archived, identity survives). It is
  deliberately the last resort, behind a link that states what it erases.

Dev DBs are disposable — a reset DB has no accounts, so **re-register** each time.
For email/password tests you do **not** need any OAuth app configured.

## Testing the app end-to-end (runbook for an agent)

Use **tmux** to drive the CLI (a real Claude Code TUI — keep it on **haiku** to stay cheap)
and the **Chrome MCP tools** to drive the web. Load the Chrome tools first with one
ToolSearch (`select:mcp__claude-in-chrome__tabs_context_mcp,…navigate,…computer,…read_page,…tabs_create_mcp,…form_input,…read_console_messages`).

1. **Stack up:** `@kvy/server` dev on :3005 and `@kvy/web` dev on :3000 in tmux panes
   (or background) — no Docker/local Postgres needed, `DATABASE_URL` already points at Neon.
   If ports clash with another worktree, pick free ones and set
   `PORT`/`NEXT_PUBLIC_API_URL`/`KVY_BACKEND_URL` to match — never blanket-kill by process name.
2. **Prepare the account (Chrome MCP):** open `http://localhost:3000/signin/` (`/` is the public
   landing page; the app lives under `/dashboard/**`, auth-gated)
   → go to `/password/` → **Sign up** with a throwaway email + password, then pick how this
   browser protects its keys (headless Chrome has no platform authenticator, so it
   auto-resolves to "stay signed in"). This registers the account, generates the
   `masterSecret`, and binds the key epoch — you land authenticated.
3. **Pair the CLI (tmux):** with the env vars above, run `kvy auth login`. It prints a pairing
   URL/QR — open that URL in the already-signed-in Chrome tab and **approve**. The CLI now holds a
   real refresh token + the sealed `masterSecret`; check with `kvy auth status`.
4. **Start a session (tmux):** in a project dir, `kvy claude --model haiku`. The daemon
   auto-starts, registers the machine, and mirrors the (encrypted) transcript.
5. **Verify (Chrome MCP):** the session appears on Home; open its timeline. Exercise the auth
   surface specifically: **reload keeps you in with no prompt at all** (silent refresh, no
   `/signin/` bounce); Settings → **Devices** lists sessions and "log out other devices"
   drops the revoked session's socket immediately; wrong-password lockout after repeated
   attempts.
6. **Key sharing (Chrome MCP):** open a second browser profile, sign in with the same
   account → it shows "One more step" with a 6-digit code. The first profile pops an
   approve card showing the **same** code plus a server-attested device row. Approve, and
   the second profile continues on its own. Also check a **mismatch drill**: raise a
   request from a third profile and confirm the codes differ.
7. **Zero machines:** sign in on a fresh account without running the CLI — expect the
   three-step install onboarding, no "New session" button, and the screen advancing by
   itself once `kvy` registers a machine.

Process hygiene: only manage processes you started, verify a PID's cwd before killing it, and
prefer non-default ports when another worktree may be running its own stack.

## Auth & UX principles

Seven rules every auth-adjacent change follows (docs/auth-ux-overhaul-plan.md):

1. **Never print "run X" when you can run X.** A missing login is a first run, not an error.
2. **Identity first, crypto second.** Sign-in gates always run before key-material gates.
3. **First device = zero questions.** A user with no data never sees a crypto screen.
4. **No internal words in the UI.** Banned: `keyEpoch`, `masterSecret`, `bind`, `custody`,
   `bridge`, `epoch`, `DEK`, `nonce`, `ephPub`. Enforced by `lib/__tests__/copy.test.ts`
   and `cli/src/ui/messages.test.ts`.
5. **Never put a destructive button next to a safe one.** Destructive goes behind a link
   and states its consequence in the label (`components/auth/start-over-link.tsx`).
6. **Every waiting screen updates itself.** No "reopen this link", no manual refresh.
7. **Never claim a security property you have not verified.** If a control only raises
   cost rather than preventing an attack, say so in the same sentence — see
   `web/src/crypto/device-key.ts`'s docblock for the shape of an honest one.

## Conventions

- **pnpm workspaces** — `pnpm-workspace.yaml` globs `packages/*`. Add new packages there;
  no other wiring needed for pnpm to pick them up.
- **Strict TypeScript** — every package extends root `tsconfig.base.json` (strict mode,
  `noUncheckedIndexedAccess`, `noImplicitReturns`, etc.). Don't loosen these per-package.
- **`@/` path alias** — each package's own `tsconfig.json` maps `@/*` to `./src/*`. Import
  within a package via `@/...`; import across packages via the published package name
  (e.g. `@kvy/wire`).
- **Biome** — single formatter + linter at the root (`biome.json`), not per-package. Run
  `pnpm lint` / `pnpm lint:fix` before committing.
- **`@kvy/wire` builds first** — it has no workspace dependencies and everything else
  depends on its compiled output; this is why CI and `postinstall` (`scripts/postinstall.cjs`,
  skippable via `SKIP_KVY_WIRE_BUILD=1`) build it explicitly ahead of the general build.

## Docs

- `plan.md` — the build plan and the authoritative phase/task checklist (§16).
- `kvy-system-design.md` — architecture, protocol, and encryption design.
- `kvy-prd.md` — product requirements.
- `docs/protocol.md`, `docs/encryption.md` — short stubs pointing into the design doc.
- `docs/uninstall.md` — user-facing uninstall/cleanup guide: `kvy daemon service
  uninstall` and the full `rm -rf ~/.kvy` walkthrough (kvy-prd.md FR-1.6). There is
  no shell shim — `kvy` never shadows the real `claude`/`codex`/`opencode` commands;
  the only supported invocation is explicit (`kvy claude`, `kvy codex`, or bare
  `kvy` for the default provider).
- `deploy/README.md` — self-host walkthrough (`deploy/docker-compose.yml`: server +
  postgres + optional minio, migrate-on-boot, split-origin web with strict CSP + SRI).

Update this file as each phase lands new packages (e.g. once `cli`/`server`/`web` exist,
move them out of "planned" above and add any new root-level commands they introduce).
