# Contributing to Kvy

Thanks for considering a contribution. This doc covers the day-to-day mechanics —
branching, CI, releases. For build/test commands and package layout, see
[`AGENTS.md`](./AGENTS.md); for architecture, see
[`docs/kvy-system-design.md`](./docs/kvy-system-design.md).

## Branch model

`main` is the only long-lived branch. Always releasable, protected (PR + green CI
required). No `develop`, no GitFlow — not needed at this scale, and a second
permanent branch is just another thing that can drift out of sync.

## Day-to-day: feature or bugfix

```bash
git checkout -b <name>/<short-description> main
# work, commit
gh pr create --base main
```

- CI (`.github/workflows/ci.yml`) runs on every PR: lint → build `@kvy/wire` →
  wire additive-only schema check → typecheck → test. Must be green before
  merging.
- Squash-merge. Keeps `main` bisectable.
- Delete the branch after merge.

No special-casing "bugfix" vs "feature" branches — same flow either way.

## Release CI (CLI only)

`.github/workflows/release.yml` is Changesets-driven — it triggers on every push
to `main`, not a manual tag:

1. `changeset publish` decides whether anything is actually versioned to publish.
   `kvy` is the only package this repo ever publishes to npm — `@kvy/wire` and
   `@kvy/crypto` are `private: true` and bundled straight into `kvy`'s own build
   output by pkgroll (they're `devDependencies` of `kvy`, not `dependencies`,
   which is what makes pkgroll inline them instead of leaving them as external
   runtime deps); `@kvy/server` / `@kvy/web` / `@kvy/e2e` are deploy-only. All
   four are excluded via `.changeset/config.json`'s `ignore`.
2. If `kvy` was published, a resolver step mints the matching `vX.Y.Z` tag
   (changesets' own tag is `kvy@X.Y.Z`; `scripts/install.sh` and the GitHub
   Release/`cli-latest` rolling pointer expect the plain form).
3. A per-OS matrix (macOS/Linux/Windows × arm64/x64) compiles standalone Node SEA
   binaries (`packages/cli/scripts/native/`, `docs/kvy-system-design.md` §3) and
   attaches them to that tag's GitHub Release plus the rolling `cli-latest`
   pointer.

The only manual step is running `pnpm changeset` on a PR that changes `kvy`'s
published behavior (see Changesets below) — merging that PR's eventual "Version
Packages" PR is what triggers the real publish.

Needs an `NPM_TOKEN` repo secret (npm automation token with publish rights) for
the `changesets/action` publish step to authenticate — without it the job fails
with `ENEEDAUTH` (harmless: nothing gets published, just retry once the secret
exists).

The `bump-homebrew-cask` job bumps `Casks/kvy.rb` in the separate
`trankhacvy/homebrew-vibe-oss` tap repo on every real release, so `brew install
kvy` never falls behind the versioned/npm releases above. This needs a
`HOMEBREW_TAP_TOKEN` repo secret — a fine-grained PAT scoped to just that one
repo's contents (read/write) — since the default `GITHUB_TOKEN` here has no
access outside this repo. Also harmless without it: the job logs a warning and
skips, same as a missing `NPM_TOKEN` above.

## Web / backend — redeploy, not "release"

`@kvy/server` and `@kvy/web` are `"private": true` — never published anywhere, so
the CLI's versioned-release model doesn't apply. They're Docker-deployed
(`deploy/docker-compose*.yml`, `deploy/server.Dockerfile`, `deploy/web.Dockerfile`
— see [`deploy/README.md`](./deploy/README.md)).

- Merge to `main` → build + push Docker images to a registry, tagged with the
  commit SHA.
- Redeploy = pull the new image where `docker-compose` runs, restart.
- No version tags, no changelog needed for these two — "latest good commit on
  `main`" is the release.

## Changesets

See `.changeset/README.md` / [changesets.dev](https://changesets.dev) for the
day-to-day flow. Short version: run `pnpm changeset` on any PR that changes
`kvy`'s published behavior, answer its prompts, commit the generated file
alongside the PR. A bot rolls accumulated changesets into a "Version Packages"
PR; merging that PR bumps the version and is what feeds the `vX.Y.Z` tag above.

`@kvy/server`, `@kvy/web`, and `@kvy/e2e` are excluded from changesets tracking
(`ignore` in `.changeset/config.json`) — private, deploy-only, never versioned.

`human-id` (a transitive dep of `@changesets/write`) has to be pinned to `4.0.0`
via the root `pnpm.overrides` — anything newer is ESM-only and crashes
`@changesets/write`'s `require()` with `ERR_REQUIRE_ESM`. Known upstream compat
gap, not a local misconfiguration.

`changeset status`/`changeset version` need `git merge-base HEAD main` to
resolve, which fails on a **shallow clone** with "Failed to find where HEAD
diverged from main." Not a changesets bug — `git fetch --unshallow` fixes it
locally. CI runners need `actions/checkout` with `fetch-depth: 0` for the same
reason (`changesets/action`'s own docs call this out).
