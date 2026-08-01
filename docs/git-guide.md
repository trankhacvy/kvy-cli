# Git guide (personal reference)

How this repo branches, merges, and releases. Written for myself — not a
contributor doc.

## Branch model

`main` is the only long-lived branch. Always releasable, protected (PR +
green CI required). No `develop`, no GitFlow — not needed at this scale, and
a second permanent branch is just another thing that can drift out of sync.

## Day-to-day: feature or bugfix

```bash
git checkout -b <name>/<short-description> main
# work, commit
gh pr create --base main
```

- CI (`.github/workflows/ci.yml`) runs on every PR: lint → build
  `@kvy/wire` → wire additive-only schema check → typecheck → test. Must
  be green before merging.
- Squash-merge. Keeps `main` bisectable.
- Delete the branch after merge.

No special-casing "bugfix" vs "feature" branches — same flow either way.

## Release CI (CLI only)

`.github/workflows/release.yml` triggers on a `vX.Y.Z` tag push (or manual
`workflow_dispatch`): builds Bun-compiled binaries (darwin-arm64/x64,
linux-x64) → GitHub Release → rolling `cli-latest` tag (for `kvy update`)
→ `npm publish`.

**Known broken as of 2026-08-01 — do not tag a release until both are
fixed:**

1. `scripts/build-binaries.sh` calls plain `bun build --compile` with no
   handling for `node-pty` / `@napi-rs/keyring`'s native `.node` files. Fix:
   same pattern proven working this session — patch `node-pty`'s loader,
   embed `pty.node` / `spawn-helper` / `keyring.node` as build assets,
   extract-and-load at startup. Proven under Node SEA; needs re-verifying
   under Bun specifically since that's what this script actually uses.
2. `publish-npm` will 404 on `@kvy/wire` / `@kvy/crypto` — they're
   `workspace:*` deps of `kvy` but were never published to npm
   themselves. Fix: either publish them alongside `kvy`, or bundle them
   into `kvy`'s own build output so they're never an external runtime
   dependency.

Once fixed: bump `packages/cli/package.json`'s version (via Changesets, see
below), tag `vX.Y.Z`, push the tag. That's the only manual step.

## Web / backend — redeploy, not "release"

`@kvy/server` and `@kvy/web` are `"private": true` — never published
anywhere, so the CLI's versioned-release model doesn't apply. They're
Docker-deployed (`deploy/docker-compose*.yml`, `server.Dockerfile`,
`web.Dockerfile`).

- Merge to `main` → build + push Docker images to a registry (GHCR), tagged
  with the commit SHA. Separate workflow from `release.yml` — not built yet.
- Redeploy = pull the new image where `docker-compose` runs, restart.
  Whether that's automated (SSH/webhook step in CI) or manual
  `docker compose pull && up -d` is still an open call.
- No version tags, no changelog needed for these two — "latest good commit
  on `main`" is the release.

## Changesets

See `.changeset/README.md` / [changesets.dev](https://changesets.dev) for
the day-to-day flow. Short version: run `pnpm changeset` on any PR that
changes `kvy`'s published behavior, answer its prompts, commit the
generated file alongside the PR. A bot rolls accumulated changesets into a
"Version Packages" PR; merging that PR bumps the version and is what should
feed the `vX.Y.Z` tag above.

`@kvy/server`, `@kvy/web`, and `@kvy/e2e` are excluded from
changesets tracking (`ignore` in `.changeset/config.json`) — private,
deploy-only, never versioned.

`human-id` (a transitive dep of `@changesets/write`) has to be pinned to
`4.0.0` via the root `pnpm.overrides` — anything newer is ESM-only and
crashes `@changesets/write`'s `require()` with `ERR_REQUIRE_ESM`. Known
upstream compat gap, not a local misconfiguration.

`changeset status`/`changeset version` need `git merge-base HEAD main` to
resolve, which fails on a **shallow clone** (Conductor workspaces are
shallow by default) with "Failed to find where HEAD diverged from main."
Not a changesets bug — `git fetch --unshallow` fixes it locally. CI runners
need `actions/checkout` with `fetch-depth: 0` for the same reason
(`changesets/action`'s own docs call this out).
