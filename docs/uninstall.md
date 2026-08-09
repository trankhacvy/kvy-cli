# Uninstalling Kvy

Kvy keeps all of its local state under one directory, `~/.kvy`
(overridable via `KVY_HOME_DIR` — see `home.ts`), plus, if you opted into
the login-service integration, one thing outside it: a launchd/systemd-user
service registration. This page covers removing both, in order, so nothing
is left running or left behind (kvy-prd.md FR-1.6).

`kvy` never shadows the real `claude`/`codex`/`opencode` commands — there
is no PATH shim to remove; every invocation is explicit (`kvy claude`,
`kvy codex`, or bare `kvy` for the default provider).

## Quick uninstall

If you never ran `kvy daemon service install`, this one-liner is the
whole thing (FR-1.6):

```bash
kvy daemon stop && kvy kill all-force && rm -rf ~/.kvy
```

If you *did* install the service, run that command first (it's a safe
no-op if you didn't):

```bash
kvy daemon service uninstall
kvy daemon stop && kvy kill all-force && rm -rf ~/.kvy
```

Finally, remove the `kvy` binary itself (whichever install method you
used):

```bash
npm uninstall -g @vibe-oss/kvy      # npm install
rm "$(which kvy)"                   # curl | sh standalone binary
brew uninstall kvy                  # Homebrew install
```

For the Homebrew install specifically, `brew uninstall kvy` matters even if
you're about to reinstall: `rm -rf ~/.kvy` only clears Kvy's own state, not
Homebrew's Cellar/Caskroom receipt - skip this and `brew install kvy`
will report the (old) version as "already installed" and do nothing.

The rest of this page explains what each step actually does and why the
order matters.

## 1. `kvy daemon service uninstall`

Only relevant if you opted into running the daemon as a login-managed OS
service (`kvy daemon service install`, kvy-prd.md FR-4.1). `kvy
daemon service uninstall`:

- **macOS (launchd):** stops and unregisters the service (`launchctl
  bootout gui/<uid>/dev.kvy.daemon`) and deletes
  `~/Library/LaunchAgents/dev.kvy.daemon.plist`.
- **Linux (systemd --user):** stops and disables the service (`systemctl
  --user disable --now dev.kvy.daemon.service`), deletes
  `~/.config/systemd/user/dev.kvy.daemon.service`, and reloads the
  systemd user daemon.

Both report "No … service was installed" and exit 0 if the service was
never registered — safe to run unconditionally. Note these paths are
**outside** `~/.kvy` (they're OS service-manager locations), which is
why `rm -rf ~/.kvy` alone doesn't undo this step — run this command
first.

If you registered the service, you likely also ran `loginctl enable-linger
$USER` (the install step prints that as a follow-up note on Linux, not
something it runs automatically). Uninstalling the service doesn't disable
lingering; run `loginctl disable-linger $USER` yourself if you no longer
want *any* of your user services to survive logout.

## 2. Stop everything still running

Before deleting `~/.kvy`, make sure no Kvy-managed process is left
using it:

```bash
kvy daemon stop      # graceful: control-server /stop, falls back to SIGTERM/SIGKILL by pid
kvy kill all-force    # escape hatch: SIGKILLs every Kvy process found by scanning `ps`,
                         # no grace period — use this if `daemon stop` didn't fully clean up
```

`kvy kill all-force` doesn't depend on `daemon.state.json` or the control
server being reachable — it discovers targets purely by scanning the OS
process list, so it still works even if the daemon is wedged or its state
file is stale/corrupt. (`kvy kill daemon|sessions|all` are the
graceful — SIGTERM, wait, then SIGKILL — variants; `all-force` is the "just
get rid of it" one, which is what you want right before an uninstall.)

If you'd rather see what's running before killing it, `kvy doctor`
prints a categorized report of every Kvy-related process first.

## 3. `rm -rf ~/.kvy` — what's actually in there

Everything Kvy writes locally lives under one directory (design §7.2).
Deleting it removes all of the following in one shot:

| Path | What it is |
| --- | --- |
| `settings.json` | Onboarding state, machine id, backend/frontend URL overrides, daemon auto-start flag, adopted-session lineage, per-workspace git config. |
| `access.key` | Your account token + `masterSecret` (0600-permissioned) — the E2E encryption key material lives here. Deleting this is equivalent to `kvy auth logout` plus forgetting the key; without a recovery code (`kvy-prd.md` FR-2.5) or another already-signed-in device, previously-synced data becomes unrecoverable from this machine. |
| `daemon.lock` | The daemon's singleton guard (atomic hard-link + PID). Only matters while a daemon is running — step 2 above should already have removed the need for it. |
| `daemon.state.json` | The running daemon's published identity: pid, control-server port, version, machine id, wrapped DEK. Kvy has no Unix-domain-socket files to clean up — the daemon's control server is a loopback TCP listener on an OS-assigned port, and this file (plus `daemon.lock`) is how other `kvy` commands find it. Both are irrelevant once the daemon process is stopped. |
| `sessions.json` | Durable session bookkeeping (wrapped DEKs, seq numbers, versions) the daemon restores from on restart. |
| `workspaces.json` | Registered workspace directories (`kvy workspace register`). |
| `adapters/` | The managed ACP adapter installs (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`) Kvy spawns remote sessions through — its own npm prefix (`node_modules` + `package.json` + lockfile), populated by `kvy adapters install`. Safe to delete; `kvy adapters install` re-creates it. |
| `claims/` | Per-session send-idempotency claim files (`<sessionId>.json`) — the small durable record that stops a retried "send message" from running a turn twice. Bounded/short-lived; deleting mid-session only loses that at-most-once guard for in-flight sends. |
| `logs/` | File-only diagnostic logs (`kvy-*.log`, plus `daemon.service.{log,error.log}` if the service was installed) — Kvy never logs to stdout/stderr (see `logger.ts`), so this is the only place to look for CLI/daemon diagnostics, and the only place they accumulate on disk. |
| `outbox/` | Per-session queued-but-unsent API writes, retried while offline. |

A single `rm -rf ~/.kvy` removes all of it. There's no separate manifest
or registry to hunt down entries in — every file above is a direct child of
`~/.kvy`, so nothing survives the directory being gone.

If you used `KVY_HOME_DIR` to point Kvy at a different directory,
substitute that path everywhere above instead of `~/.kvy`.

## 4. What uninstalling does *not* do

Kvy is deliberately narrow about what it touches — uninstalling it
leaves the following alone:

- **Claude Code's / Codex's own config and auth** (e.g. `~/.claude`,
  `ANTHROPIC_API_KEY`, Codex's own login state). Kvy reuses whatever
  login those providers already have (kvy-prd.md FR-2.6/FR-1.3); it
  never stores provider credentials of its own, so there's nothing
  provider-side to clean up.
- **The server-side machine/account record.** Kvy has no "deregister
  this machine" API yet — once you stop the daemon, the machine simply
  shows offline (last-seen not advancing) to any other device on your
  account. Your synced session history on the server is untouched (by
  design — sync data outlives any one machine). If you also want your
  *account* gone, that's a `kvy auth logout` (already implied by
  deleting `access.key`) plus a support request for account deletion —
  there is no self-service "delete my account" flow yet.
- **Any git worktrees/branches Kvy created** (`kvy -b <branch>`) —
  those live in your project repos, not `~/.kvy`, and are yours to keep
  or clean up with normal git commands.

## Troubleshooting

- **`kvy daemon service uninstall` says the service wasn't installed,
  but I remember installing it.** Check you're running it as the same OS
  user that installed it — both launchd agents and systemd `--user` units
  are per-user, not system-wide.
- **`rm -rf ~/.kvy` refuses to remove `access.key` cleanly / a process
  still has it open.** Re-run step 2 (`kvy daemon stop && kvy kill
  all-force`) first — a still-running daemon or session process can hold
  files under `~/.kvy` open, though this doesn't block `rm -rf` itself
  on POSIX (unlinking an open file just leaves the process holding it until
  it exits); if you want a completely clean slate before deleting, confirm
  `kvy doctor` reports no Kvy processes left first.
