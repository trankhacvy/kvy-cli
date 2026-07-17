# @falcon/server — self-host runtime image (falcon-system-design.md §6.5,
# plan.md §16 "4.3 Distribution & self-host"). Multi-stage: install workspace
# deps once, build just the packages `@falcon/server` needs at runtime
# (`@falcon/wire` -> `@falcon/crypto` -> `@falcon/server`, in that dependency
# order), then ship a slim runtime layer. No native/build-tooling deps are
# required anywhere in this workspace's dependency tree (no `requiresBuild`
# entries in pnpm-lock.yaml), so `node:20-slim` is enough at every stage —
# no python3/make/g++ needed (contrast with Happy's Dockerfile.server, which
# needed those for its own dependency tree).
#
# Build from the repo root (docker-compose.yml's `build.context: ..` does
# this automatically):
#   docker build -f deploy/server.Dockerfile -t falcon-server .

FROM node:20-slim AS deps

RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts

# pnpm-lock.yaml's workspace importers cover every packages/* member — a
# `pnpm install --frozen-lockfile` needs each one's package.json present
# (even ones this image never runs, e.g. @falcon/cli/@falcon/web) or it
# refuses to proceed. Full source for those is never copied into this image.
RUN mkdir -p packages/crypto packages/wire packages/server packages/cli packages/web
COPY packages/crypto/package.json packages/crypto/
COPY packages/wire/package.json packages/wire/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/

# The workspace postinstall hook (scripts/postinstall.cjs) builds
# @falcon/wire right after install — skip it here since wire's full source
# isn't copied in yet; the builder stage below builds it explicitly, in
# dependency order, alongside crypto and server.
RUN SKIP_FALCON_WIRE_BUILD=1 pnpm install --frozen-lockfile

FROM deps AS builder

COPY turbo.json tsconfig.base.json ./
COPY packages/wire ./packages/wire
COPY packages/crypto ./packages/crypto
COPY packages/server ./packages/server

# turbo resolves the @falcon/wire -> @falcon/crypto -> @falcon/server build
# order from each package's `dependsOn: ["^build"]` (turbo.json) — the same
# graph a root `pnpm build` walks, scoped here to just this package and its
# workspace dependencies via `--filter=@falcon/server...`.
RUN pnpm exec turbo run build --filter=@falcon/server...

FROM node:20-slim AS runner

WORKDIR /repo

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3005

# Root node_modules holds pnpm's real package content under
# node_modules/.pnpm/*; each package's own node_modules/<name> entries
# (copied below along with the package directories themselves) are symlinks
# into that store, so both must land at the same relative paths they had at
# build time for module resolution to work.
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=builder /repo/packages/wire ./packages/wire
COPY --from=builder /repo/packages/crypto ./packages/crypto
COPY --from=builder /repo/packages/server ./packages/server

COPY deploy/server-entrypoint.sh /usr/local/bin/server-entrypoint.sh
RUN chmod +x /usr/local/bin/server-entrypoint.sh

# Local-disk blob fallback (`BLOB_LOCAL_DIR`, only used when `S3_BUCKET` is
# unset) writes under here — mount a named volume at /data in compose so
# blobs survive a container recreate.
VOLUME /data
EXPOSE 3005

WORKDIR /repo/packages/server
ENTRYPOINT ["/usr/local/bin/server-entrypoint.sh"]
