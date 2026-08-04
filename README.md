<div align="center">
  <img src="packages/web/public/manifest-icon-192.maskable.png" alt="Kvy" width="96" />
</div>

# Kvy

**Run Claude Code and Codex on your own machine, and control them from anywhere.**

Start a session in your terminal, walk away, and keep steering it from your phone or
browser — get notified when the agent needs a permission or finishes a turn, reply,
and it keeps going. Kvy wraps your existing `claude`/`codex` CLI so you get the exact
same terminal experience, plus a synced, end-to-end encrypted timeline you can watch
and control from a browser on any device.

## How it works

- **`kvy` is a thin wrapper**, not a reimplementation — local sessions run the real
  provider CLI untouched; Kvy observes the transcript and mirrors it out.
- **A background daemon** on your machine holds the connection to the server and can
  spawn new sessions on request (e.g. "start a session" from the web app).
- **The server is blind.** All session content — messages, diffs, attachments — is
  encrypted client-side before it ever reaches the server; it only ever sees
  ciphertext and routing metadata. See
  [`docs/kvy-system-design.md`](./docs/kvy-system-design.md) for the full design.
- **The web app** (a PWA) shows a live timeline, answers permission prompts, and
  sends follow-up messages that get typed into the real terminal session remotely.

## Quick start

**Native (recommended) — macOS / Linux / WSL:**
```bash
curl -fsSL https://kvy-cli.tkvy.dev/install.sh | sh
```

**Homebrew:**
```bash
brew install kvy
```

**npm:**
```bash
npm install -g @vibe-oss/kvy
```

Then run it from any project:
```bash
kvy claude   # or: kvy codex
```

That's it — `kvy claude` behaves exactly like `claude`, and the session shows up live
on the web app within a few seconds. By default the CLI talks to the hosted
`api.kvy-cli.tkvy.dev` / `kvy-cli.tkvy.dev` backend; see below to run your own instead.

## Self-hosting

The full backend (API server + Postgres + web app) can run entirely on your own
infrastructure — see [`deploy/README.md`](./deploy/README.md) for the Docker Compose
walkthrough and the production (Vercel + external Postgres + R2) path.

## Repository layout

pnpm + Turborepo monorepo:

```
packages/
├─ wire/      @kvy/wire    Zod schemas — shared wire protocol contract.
├─ crypto/    @kvy/crypto  E2E encryption primitives (node + browser).
├─ cli/       kvy          CLI + daemon + ACP adapter + git/workspace/github/preview subsystems.
├─ server/    @kvy/server  Fastify server, Postgres, Socket.IO, auth, push dispatch.
└─ web/       @kvy/web     Next.js PWA — home, session timeline, git, checks, preview, settings.
```

See [`docs/packages-guide.md`](./docs/packages-guide.md) for per-package internals.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

See [`AGENTS.md`](./AGENTS.md) for the full command reference and local dev stack
setup, and [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the branching/release model.

## Docs

- [`AGENTS.md`](./AGENTS.md) — commands, conventions, and dev setup (for humans and coding agents alike)
- [`docs/kvy-prd.md`](./docs/kvy-prd.md) — product requirements
- [`docs/kvy-system-design.md`](./docs/kvy-system-design.md) — architecture, protocol, and encryption design
- [`docs/packages-guide.md`](./docs/packages-guide.md) — per-package internals
- [`docs/uninstall.md`](./docs/uninstall.md) — full uninstall/cleanup guide
- [`deploy/README.md`](./deploy/README.md) — self-hosting and production deployment

## License

MIT — see [`LICENSE`](./LICENSE). Portions of the codebase are ported from
[Happy](https://github.com/slopus/happy) (also MIT); those files carry their own
attribution headers.
