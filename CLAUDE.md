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
├─ wire/      @falcon/wire    zod schemas — the shared wire protocol contract.
│                             Built first (everything else depends on it).
├─ crypto/    @falcon/crypto  E2E encryption primitives, isomorphic (node + browser builds).
├─ cli/       falcon          CLI skeleton: hand-rolled arg parsing (`falcon` / `falcon claude
│                             [args...]` / `falcon codex [args...]` with full flag passthrough),
│                             file-only logger (`~/.falcon/logs/`, never stdout/stderr). Auth,
│                             daemon, and provider spawning still [planned].
├─ server/    @falcon/server  Fastify 5 app skeleton (zod type-provider, /health, pino
│                             logging) + Drizzle ORM schema (`src/db/schema.ts`) and
│                             migrations (`drizzle/`), migration-on-boot runner + auth
│                             module (src/auth/: JWT HS256 mint/verify, in-memory token
│                             cache, app.authenticate preHandler).
│                             Socket.IO/auth *routes* still [planned].
└─ web/       @falcon/web     Next.js PWA (App Router, static export). Tailwind + shadcn/ui
                              wired up, dark default theme, one placeholder route. Auth,
                              sync engine, crypto bridge, and API calls still [planned].
```

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

Update this file as each phase lands new packages (e.g. once `cli`/`server`/`web` exist,
move them out of "planned" above and add any new root-level commands they introduce).
