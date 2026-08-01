# @kvy/web — self-host static build + nginx runtime (kvy-system-design.md
# §5.3/§9, plan.md §16 "4.3 Distribution & self-host": statically exported,
# served from an origin separate from the API, strict CSP + SRI).
#
# `@kvy/web` reads its API origin (and a few optional public OAuth/VAPID
# ids) from `NEXT_PUBLIC_*` env vars *inlined at build time* — there is no
# server at request time for a static export to read env from (see
# packages/web/src/lib/config.ts). That means this image must be rebuilt
# whenever those values change; docker-compose.yml passes them as
# `build.args`.
#
# Build from the repo root (docker-compose.yml's `build.context: ..` does
# this automatically):
#   docker build -f deploy/web.Dockerfile \
#     --build-arg API_ORIGIN=https://api.example.com -t kvy-web .

FROM node:20-slim AS deps

RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts

# pnpm-lock.yaml's workspace importers cover every packages/* member — a
# `pnpm install --frozen-lockfile` needs each one's package.json present
# (even ones this image never runs, e.g. @kvy/cli/@kvy/server) or it
# refuses to proceed. Full source for those is never copied into this image.
RUN mkdir -p packages/crypto packages/wire packages/server packages/cli packages/web
COPY packages/crypto/package.json packages/crypto/
COPY packages/wire/package.json packages/wire/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/

# `--ignore-scripts`: the lockfile's `onlyBuiltDependencies: ["node-pty"]`
# (root package.json) is only there for @kvy/cli's PTY sessions — this
# image never runs cli, but pnpm still resolves its package.json (workspace
# completeness, comment above) and would otherwise try to compile node-pty's
# native addon here. node-pty ships prebuilt binaries for darwin/win32 only,
# NOT linux, so that build falls back to node-gyp — which needs
# python3/make/g++, none of which `node:20-slim` has.
RUN SKIP_KVY_WIRE_BUILD=1 pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS builder

ARG API_ORIGIN=http://localhost:3005
ARG GOOGLE_OAUTH_CLIENT_ID=""
ARG GITHUB_OAUTH_CLIENT_ID=""
ARG VAPID_PUBLIC_KEY=""

ENV NODE_ENV=production
ENV NEXT_PUBLIC_API_URL=$API_ORIGIN
ENV NEXT_PUBLIC_KVY_API_URL=$API_ORIGIN
ENV NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID=$GOOGLE_OAUTH_CLIENT_ID
ENV NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID=$GITHUB_OAUTH_CLIENT_ID
ENV NEXT_PUBLIC_VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY

COPY turbo.json tsconfig.base.json ./
COPY packages/wire ./packages/wire
COPY packages/crypto ./packages/crypto
COPY packages/web ./packages/web

# turbo resolves the @kvy/wire -> @kvy/crypto -> @kvy/web build
# order from each package's `dependsOn: ["^build"]` (turbo.json). `next
# build` (invoked by @kvy/web's own `build` script) writes the static
# export to packages/web/out/ per next.config.ts's `output: "export"`.
RUN pnpm exec turbo run build --filter=@kvy/web...

FROM nginx:1.27-alpine AS runner

COPY --from=builder /repo/packages/web/out /usr/share/nginx/html
COPY deploy/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/web/docker-entrypoint.sh /docker-entrypoint-wrapper.sh
RUN chmod +x /docker-entrypoint-wrapper.sh

EXPOSE 80
ENTRYPOINT ["/docker-entrypoint-wrapper.sh"]
CMD ["nginx", "-g", "daemon off;"]
