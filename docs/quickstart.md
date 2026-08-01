# Quickstart

> **Status:** stub — outline + pointers only, mirroring `docs/protocol.md`/
> `docs/encryption.md`'s "lightweight pointer doc, expand as the area lands"
> convention (`plan.md` §16 0.1). This is the docs-site landing page named
> by `plan.md` §16 "4.4 Hardening & release gate": "docs site quickstart;
> onboarding time measured <5min" — kvy-prd.md §5.1/§7 both cite the
> same target ("onboarding < 5 min measured" is Phase 4's exit criterion).

Kvy wraps your existing Claude Code / Codex CLI so you get the exact same
terminal experience, plus a synced, encrypted timeline you can watch and
control from a browser on any device. This page is the whole install → first
remote-controlled session path — if it takes you longer than 5 minutes
end-to-end, that's a bug; see "Reporting onboarding time" below.

## 1. Install (~1 min)

Pick one:

```bash
# Standalone binary, no Node required (macOS arm64/x64, Linux x64)
curl -fsSL https://kvy.dev/install.sh | sh

# Or, if you already have Node ≥20:
npm install -g kvy
```

Both put a `kvy` binary on your `PATH` (`~/.kvy/bin/kvy` for the
curl installer). Verify:

```bash
kvy --version
```

## 2. Sign in (~1 min)

```bash
kvy auth login
```

Opens a browser for OAuth-style sign-in (email+password, Google, or
GitHub — kvy-prd.md FR-2.1). On success, the CLI stores an encrypted
token under `~/.kvy/` and this machine is linked to your account. Check
anytime with `kvy auth status`.

## 3. Start a session (~1 min)

From any project directory:

```bash
cd your-project
kvy
```

This is `kvy claude [args...]` by default — the **real** Claude Code TUI
starts exactly as if you'd run `claude` directly (same keybindings, same
slash commands, same flags pass through untouched). Behind the scenes,
Kvy auto-starts a background daemon, registers this machine, and begins
mirroring the session transcript to your account — encrypted client-side
before it ever leaves this machine (kvy-system-design.md §5).

Prefer Codex? `kvy codex [args...]` works the same way.

Already have a plain `claude` session running from muscle memory?
`kvy adopt` (or `kvy --continue` for the most recent one) imports its
history and continues it under Kvy — no need to restart anything
(kvy-prd.md FR-9.2).

## 4. Watch and control it from the web (~1 min)

Open the dashboard (`https://app.kvy.dev`, or your self-hosted origin)
and sign in with the same account. Your new session appears on the Home
screen, grouped by workspace, with a live status dot. Open it for the full
structured timeline (markdown, tool calls, diffs) as it happens.

Send a follow-up message from the composer, or tap **Take control** to
switch the session into remote mode — the agent keeps running headlessly
and any pending permission prompts route to your browser as Allow / Deny /
Allow-for-session cards (kvy-prd.md FR-3.4/FR-7.3/FR-7.4). Press Ctrl-T
in the terminal any time to take local control back.

## Troubleshooting

- `kvy doctor` — one-shot diagnostic: auth state, provider detection,
  daemon health, backend connectivity, version (kvy-prd.md FR-1.4).
- Stuck processes: `kvy kill daemon|sessions|all|all-force` — works even
  if the daemon itself is wedged, since it scans processes directly rather
  than asking the daemon to clean up after itself.
- Self-hosting instead of the hosted backend? See `deploy/README.md`.

## Reporting onboarding time

Phase 4's exit criterion (`plan.md` §16 "4.4 Hardening & release gate",
kvy-prd.md §7 "M4 — Ship") is **"public beta installable via one command;
magic-moment demo reproducible by a stranger from the README"** with
onboarding measured at **< 5 minutes**. To measure and report a run:

1. Time yourself (or a fresh tester with no prior Kvy exposure) from
   step 1's install command to completing step 4 (seeing the live session
   in the web dashboard and successfully answering one permission prompt
   remotely, or sending one composer message).
2. Record: total wall-clock time, which step (if any) took longest, and any
   point that required looking beyond this page for an answer.
3. File the result as a comment on the `plan.md` §16 "4.4" checklist item
   (or the tracking issue, once `to-issues` has split this plan into
   issues) — include OS/platform and install method (curl vs npm), since
   those are the two variables most likely to move the number.

No tooling automates this yet — it's a stopwatch-and-a-stranger measurement
by design, the same way Happy and Omnara validated their own onboarding
funnels. A scripted/instrumented version (e.g. timestamped CLI telemetry
from install to first successful remote answer) is a reasonable fast-follow
but is out of scope for this stub.

## See also

- `docs/protocol.md`, `docs/encryption.md` — wire protocol and encryption
  design pointers.
- `deploy/README.md` — self-hosting via Docker Compose.
- `kvy-prd.md` §5.1 "Installation & Onboarding", §5.3 "The CLI" — full
  requirement list behind this page.

---

**TODO once the docs site itself exists:** this file is currently the whole
"docs site" — plan.md §16 "4.4" calls for a "docs site quickstart page",
and a real static-site generator (or a `packages/web` route) serving this
content publicly is follow-on work. Until then this Markdown file is the
canonical quickstart, linked from the repo root.
