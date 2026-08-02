# @kvy/server — self-host runtime image (kvy-system-design.md §6.5,
# plan.md §16 "4.3 Distribution & self-host"). Multi-stage: install workspace
# deps once, build just the packages `@kvy/server` needs at runtime
# (`@kvy/wire` -> `@kvy/crypto` -> `@kvy/server`, in that dependency
# order), then ship a slim runtime layer. `node:20-slim` is enough at every
# stage — this image never needs python3/make/g++ (contrast with Happy's
# Dockerfile.server, which needed those for its own dependency tree) — but
# only because the deps stage installs with `--ignore-scripts` (see its own
# comment): the workspace's `node-pty` dependency (only actually used by
# `@kvy/cli`, never this image) has no Linux prebuilt binary, so an
# ordinary install would try to compile it via node-gyp and fail here.
#
# Build from the repo root (docker-compose.yml's `build.context: ..` does
# this automatically):
#   docker build -f deploy/server.Dockerfile -t kvy-server .

FROM node:20-slim AS deps

RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
COPY patches ./patches

# pnpm-lock.yaml's workspace importers cover every packages/* member — a
# `pnpm install --frozen-lockfile` needs each one's package.json present
# (even ones this image never runs, e.g. @kvy/cli/@kvy/web) or it
# refuses to proceed. Full source for those is never copied into this image.
RUN mkdir -p packages/crypto packages/wire packages/server packages/cli packages/web
COPY packages/crypto/package.json packages/crypto/
COPY packages/wire/package.json packages/wire/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/

# The workspace postinstall hook (scripts/postinstall.cjs) builds
# @kvy/wire right after install — skip it here since wire's full source
# isn't copied in yet; the builder stage below builds it explicitly, in
# dependency order, alongside crypto and server. `--ignore-scripts`: the
# lockfile's `onlyBuiltDependencies: ["node-pty"]` (root package.json) is
# only there for @kvy/cli's PTY sessions — this image never runs cli, but
# pnpm still resolves its package.json (workspace completeness, comment
# above) and would otherwise try to compile node-pty's native addon here.
# node-pty ships prebuilt binaries for darwin/win32 only, NOT linux, so that
# build falls back to node-gyp — which needs python3/make/g++, none of which
# `node:20-slim` has (confirmed failing without this flag: node-gyp's own
# "find Python" step fails outright). Safe to skip entirely: this stage's
# only job is populating node_modules, and no script this workspace's own
# postinstall/build steps need runs here (wire's real build is the explicit
# `turbo run build` below, unaffected by this install's --ignore-scripts).
RUN SKIP_KVY_WIRE_BUILD=1 pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS builder

COPY turbo.json tsconfig.base.json ./
COPY packages/wire ./packages/wire
COPY packages/crypto ./packages/crypto
COPY packages/server ./packages/server

# turbo resolves the @kvy/wire -> @kvy/crypto -> @kvy/server build
# order from each package's `dependsOn: ["^build"]` (turbo.json) — the same
# graph a root `pnpm build` walks, scoped here to just this package and its
# workspace dependencies via `--filter=@kvy/server...`.
RUN pnpm exec turbo run build --filter=@kvy/server...

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
