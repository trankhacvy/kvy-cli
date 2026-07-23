# Competitive notes — Omnara

Live walkthrough of Omnara's dashboard (`remote.omnara.com`, 2026-07-22) — the New Session
wizard, all 9 settings tabs (General, Git, Agent, Providers, Machines, Completed Chats,
Support, Cloud Billing, Desktop App), and a live session's detail view (composer, right
sidebar's Changes/Repo Files/Checks tabs, Setup/Run panel, Preview tunnel). This is a raw
feature inventory — everything Omnara has that Falcon doesn't yet, ordered by how much it's
worth building, not a build plan. No effort/feasibility estimates below; that's a follow-up
exercise once priorities are picked.

## Effort tags

Each item is tagged `[quick]` or `[deep: <slug>]` — read directly by
`.claude/workflows/falcon-feature-workflow.js` (invoke as `/falcon-feature-loop <item number or
title>`) to pick the pipeline: `[quick]` gets one Sonnet 5 agent, worktree-isolated, that does
the whole implement → test → verify → merge cycle itself; `[deep: <slug>]` gets the full
Opus 4.8 (solution) → Fable 5 (plan) → Sonnet 5 (implement) → Sonnet 5 (independent test/review)
→ merge pipeline, with a running `docs/features/<slug>.md` doc. The tag reflects whether a
feature touches multiple interacting subsystems or has a real judgment call worth a researched
plan first — not raw size.

## Tier 1 — big, worth having

1. **Cloud Sandbox (hosted execution).** **[deep: cloud-sandbox]** A selectable "machine" in the New Session wizard
   that isn't a registered machine at all — Omnara runs the session on managed cloud infra
   instead of requiring you to bring your own daemon. Has its own metered credits + billing
   (Settings → Cloud Billing: "$0.00 remaining · Add credits"). Falcon requires a registered
   machine with a running daemon for every session, full stop.
2. **Automatic per-session git worktree isolation.** **[deep: worktree-isolation]** Starting a new session offers "A new
   branch" (auto-generated name or custom, creates an isolated worktree for that session) vs
   "Repo root" (work directly in the main checkout) — and you can also target an *existing*
   branch (e.g. a stale `wf/...` branch) and get a fresh worktree for it. Configurable as a
   global default too (Settings → Git: "New worktree (Recommended)" vs "Repo root"). Falcon's
   wizard always spawns directly in the picked directory — no worktree option at all.
3. **Real git write actions in the session sidebar.** **[deep: git-write-actions]** Falcon's git panel (`falcon-prd.md`
   FR-7.7) is explicitly read-only for the MVP. Omnara's sidebar has one-click **Commit**,
   **Push**, and **Force Push**, inline branch rename (click the branch name, it becomes an
   editable field), and a "Compare against" selector accepting *any* branch, tag, commit SHA,
   or `HEAD (uncommitted)` — not a fixed base ref.
4. **GitHub PR/CI integration.** **[deep: github-pr-ci]** A "Checks" tab in the sidebar shows real CI check results
   once you push and open a PR ("Open a pull request to see CI checks — Commit and push your
   changes, then create a PR"), backed by a GitHub OAuth connection surfaced in Settings → Git
   ("GitHub is not connected — Login to GitHub to resolve pull requests and CI checks").
5. **Full repo file browser.** **[quick]** A "Repo Files" sidebar tab browses and displays *any* file in
   the repo (full syntax-highlighted viewer, line numbers), not just files with diffs — a
   read-only code viewer with no separate editor needed.
6. **Live dev-server preview via secure tunnel.** **[deep: dev-server-preview]** The "Preview" tab auto-detects open local
   ports ("14 ports detected · 0 tunnels active") and, given a port, opens a **Cloudflare
   tunnel** so the running dev server is viewable remotely, embedded directly in the
   dashboard — no manual ngrok/tunnel setup.
7. **Per-workspace Setup/Run scripts.** **[deep: setup-run-scripts]** Workspace settings has a persisted "Setup script"
   (runs on every new worktree creation, e.g. `npm install`) and "Run script" (one-click
   launch via a play button, e.g. `npm run dev`) — a full bootstrap-and-run lifecycle tied to
   session/worktree creation, feeding directly into the Preview tunnel above.
8. **Native desktop apps.** **[deep: desktop-apps]** Mac (Apple Silicon `.dmg`), Windows x64 (`.exe`), Windows ARM64
   (`.exe`) — described in-app as "Parallel agents in isolated worktrees, inline Git diffs,
   and system notifications — no browser tab required." Falcon is CLI + web/PWA only.
9. **Provider account inspection + usage metering.** **[quick]** Settings → Providers shows live,
   refreshable account metadata per machine: provider, auth type, email, organization,
   billing type (e.g. "Stripe Subscription"), org role, last-refreshed timestamp — plus a
   **monthly usage meter with a reset date** ("100% used · Resets Aug 18, 11:29 AM"), read
   straight from the local CLI's own auth config files (`~/.claude.json`, etc.).
10. **Session lifecycle actions.** **[deep: session-lifecycle-actions]** A session's context menu (right sidebar list) has one-click
    **Restart**, **Stop**, **Pin**, **Rename**, and **Mark done** — the last of which moves it
    to a dedicated "Completed Chats" (archived sessions) view with a **Restore** action.
11. **QR-code mobile handoff.** **[quick]** Every session shows a QR code ("Continue on mobile — Scan to
    open this session in the Omnara app") plus a copy-link button, for instant session handoff
    to a phone.
12. **Sleep-inhibit control.** **[deep: sleep-inhibit]** Settings → Machines has a per-machine "Sleep Inhibit" setting
    (Off / While on Power / Always) so a Mac won't sleep mid-session.

## Tier 2 — solid, nice to have

13. **1M-context model variants** **[quick]** exposed as distinct picks in the model dropdown ("Sonnet 5
    (1M)", "Opus 4.8 (1M)"), separate from the base model.
14. **Codex "Effort" setting** **[quick]** (Low / Medium / High / Extra High / Max) as a persisted global
    default in Settings → Agent, independent of model choice.
15. **Global default provider + default model per provider** **[quick]**, persisted account-wide
    (Settings → Agent: a "Default provider" toggle and per-provider model dropdown for both
    Claude Code and Codex).
16. **Searchable base-branch picker** **[quick]** in the New Session wizard ("from ▾" — search box over
    the real branch list, e.g. `main`/`master`), not just a fixed default.
17. **"@" file-mention autocomplete** **[quick]** in the composer — typing `@` opens a searchable picker
    over real repo files (e.g. `CLAUDE.md`, `package.json`) to reference inline.
18. **"/" slash-command autocomplete** **[quick]** that surfaces the project's *actual custom* Claude Code
    slash commands (read live from `.claude/commands/`), not just built-ins.
19. **Voice input** **[quick]** (microphone icon) in the composer.

## Tier 3 — small / cosmetic, nice to have

20. **[quick]** Collapsible left navigation for a focused, full-width session view.
21. **[quick]** One-click "copy working directory path" affordance in the session header.
22. **[quick]** Favorite/star a default machine, provider, and model directly in their picker dropdowns.
23. **[quick]** In-app Discord community link + direct support email in Settings → Support.

## Method

Live-navigated `remote.omnara.com` via Chrome MCP browser automation (already-authenticated
session, same account as this machine's real Claude Code/Codex CLIs) — the dashboard's own
new-session wizard, every settings tab, and a real session's sidebar/composer were clicked
through and screenshotted directly; nothing here is from marketing copy alone except item 8's
exact quoted description. No destructive actions were taken (Commit/Push/Force Push, the
preview tunnel's "Go", and workspace/session deletion were all identified but never triggered).
