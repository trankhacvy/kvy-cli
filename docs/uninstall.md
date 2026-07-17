# Uninstalling Falcon

Falcon keeps all of its local state under one directory, `~/.falcon`
(overridable via `FALCON_HOME_DIR` — see `home.ts`), plus, if you opted into
the shell shim or the login-service integration, a couple of things outside
it: a PATH block in your shell rc file, and a launchd/systemd-user service
registration. This page covers removing all three, in order, so nothing is
left running or left behind (falcon-prd.md FR-1.6).

## Quick uninstall

If you never ran `falcon shim install` or `falcon daemon service install`,
this one-liner is the whole thing (FR-1.6):

```bash
falcon daemon stop && falcon kill all-force && rm -rf ~/.falcon
```

If you *did* install the shim and/or the service, run those two commands
first (they're safe/no-ops if you didn't):

```bash
falcon shim uninstall
falcon daemon service uninstall
falcon daemon stop && falcon kill all-force && rm -rf ~/.falcon
```

Finally, remove the `falcon` binary itself (whichever install method you
used):

```bash
npm uninstall -g falcon          # npm install
rm "$(which falcon)"             # curl | sh standalone binary
```

The rest of this page explains what each step actually does and why the
order matters.

## 1. `falcon shim uninstall`

Only relevant if you opted into the Tier 3 shell shim (`falcon shim
install`, falcon-prd.md FR-9.6) — the `claude`/`codex` PATH shim that makes
plain `claude`/`codex` invocations transparently Falcon-managed. `falcon
shim uninstall`:

- Removes `~/.falcon/bin/claude` and `~/.falcon/bin/codex`, if present.
- Strips the Falcon PATH block from **every** rc file that has one — not
  just the one shell you're currently running. `install` only writes into
  your `$SHELL`-detected rc file, but `uninstall` scans all four candidates
  (`.zshrc`, `.bashrc`, `.config/fish/config.fish`, `.profile`) in case you
  switched shells since installing. The block is clearly marked:

  ```
  # >>> falcon shell shim >>>
  export PATH="$HOME/.falcon/bin:$PATH"
  # <<< falcon shell shim <<<
  ```

  Removal only ever touches text between those two markers (plus the blank
  line before them) — nothing else in your rc file is modified.

Safe to run even if the shim was never installed: it reports "No shims
were installed" / "No rc files had a Falcon PATH block" and exits 0.

Run `falcon shim status` at any point to check what's currently installed
without changing anything.

**Restart your shell** (or `source` the rc file(s) it printed) after
uninstalling, so the PATH change actually takes effect in your current
session.

## 2. `falcon daemon service uninstall`

Only relevant if you opted into running the daemon as a login-managed OS
service (`falcon daemon service install`, falcon-prd.md FR-4.1). `falcon
daemon service uninstall`:

- **macOS (launchd):** stops and unregisters the service (`launchctl
  bootout gui/<uid>/dev.falcon.daemon`) and deletes
  `~/Library/LaunchAgents/dev.falcon.daemon.plist`.
- **Linux (systemd --user):** stops and disables the service (`systemctl
  --user disable --now dev.falcon.daemon.service`), deletes
  `~/.config/systemd/user/dev.falcon.daemon.service`, and reloads the
  systemd user daemon.

Both report "No … service was installed" and exit 0 if the service was
never registered — safe to run unconditionally. Note these paths are
**outside** `~/.falcon` (they're OS service-manager locations), which is
why `rm -rf ~/.falcon` alone doesn't undo this step — run this command
first.

If you registered the service, you likely also ran `loginctl enable-linger
$USER` (the install step prints that as a follow-up note on Linux, not
something it runs automatically). Uninstalling the service doesn't disable
lingering; run `loginctl disable-linger $USER` yourself if you no longer
want *any* of your user services to survive logout.

## 3. Stop everything still running

Before deleting `~/.falcon`, make sure no Falcon-managed process is left
using it:

```bash
falcon daemon stop      # graceful: control-server /stop, falls back to SIGTERM/SIGKILL by pid
falcon kill all-force    # escape hatch: SIGKILLs every Falcon process found by scanning `ps`,
                         # no grace period — use this if `daemon stop` didn't fully clean up
```

`falcon kill all-force` doesn't depend on `daemon.state.json` or the control
server being reachable — it discovers targets purely by scanning the OS
process list, so it still works even if the daemon is wedged or its state
file is stale/corrupt. (`falcon kill daemon|sessions|all` are the
graceful — SIGTERM, wait, then SIGKILL — variants; `all-force` is the "just
get rid of it" one, which is what you want right before an uninstall.)

If you'd rather see what's running before killing it, `falcon doctor`
prints a categorized report of every Falcon-related process first.

## 4. `rm -rf ~/.falcon` — what's actually in there

Everything Falcon writes locally lives under one directory (design §7.2).
Deleting it removes all of the following in one shot:

| Path | What it is |
| --- | --- |
| `settings.json` | Onboarding state, machine id, backend/frontend URL overrides, daemon auto-start flag, adopted-session lineage, per-workspace git config. |
| `access.key` | Your account token + `masterSecret` (0600-permissioned) — the E2E encryption key material lives here. Deleting this is equivalent to `falcon auth logout` plus forgetting the key; without a recovery code (`falcon-prd.md` FR-2.5) or another already-signed-in device, previously-synced data becomes unrecoverable from this machine. |
| `daemon.lock` | The daemon's singleton guard (atomic hard-link + PID). Only matters while a daemon is running — step 3 above should already have removed the need for it. |
| `daemon.state.json` | The running daemon's published identity: pid, control-server port, version, machine id, wrapped DEK. Falcon has no Unix-domain-socket files to clean up — the daemon's control server is a loopback TCP listener on an OS-assigned port, and this file (plus `daemon.lock`) is how other `falcon` commands find it. Both are irrelevant once the daemon process is stopped. |
| `sessions.json` | Durable session bookkeeping (wrapped DEKs, seq numbers, versions) the daemon restores from on restart. |
| `workspaces.json` | Registered workspace directories (`falcon workspace register`). |
| `bin/` | The shell-shim binaries (`claude`, `codex`), if installed — `falcon shim uninstall` (step 1) already removes these individually; this just catches anything left behind. |
| `logs/` | File-only diagnostic logs (`falcon-*.log`, plus `daemon.service.{log,error.log}` if the service was installed) — Falcon never logs to stdout/stderr (see `logger.ts`), so this is the only place to look for CLI/daemon diagnostics, and the only place they accumulate on disk. |
| `outbox/` | Per-session queued-but-unsent API writes, retried while offline. |

A single `rm -rf ~/.falcon` removes all of it. There's no separate manifest
or registry to hunt down entries in — every file above is a direct child of
`~/.falcon`, so nothing survives the directory being gone.

If you used `FALCON_HOME_DIR` to point Falcon at a different directory,
substitute that path everywhere above instead of `~/.falcon`.

## 5. What uninstalling does *not* do

Falcon is deliberately narrow about what it touches — uninstalling it
leaves the following alone:

- **Claude Code's / Codex's own config and auth** (e.g. `~/.claude`,
  `ANTHROPIC_API_KEY`, Codex's own login state). Falcon reuses whatever
  login those providers already have (falcon-prd.md FR-2.6/FR-1.3); it
  never stores provider credentials of its own, so there's nothing
  provider-side to clean up.
- **The server-side machine/account record.** Falcon has no "deregister
  this machine" API yet — once you stop the daemon, the machine simply
  shows offline (last-seen not advancing) to any other device on your
  account. Your synced session history on the server is untouched (by
  design — sync data outlives any one machine). If you also want your
  *account* gone, that's a `falcon auth logout` (already implied by
  deleting `access.key`) plus a support request for account deletion —
  there is no self-service "delete my account" flow yet.
- **Any git worktrees/branches Falcon created** (`falcon -b <branch>`) —
  those live in your project repos, not `~/.falcon`, and are yours to keep
  or clean up with normal git commands.

## Troubleshooting

- **`falcon daemon service uninstall` says the service wasn't installed,
  but I remember installing it.** Check you're running it as the same OS
  user that installed it — both launchd agents and systemd `--user` units
  are per-user, not system-wide.
- **A `claude`/`codex` command still resolves to the Falcon shim after
  uninstalling.** Your shell has the old `PATH` cached for this session —
  `falcon shim uninstall` edits the rc file, but that only takes effect in
  *new* shells. Restart your terminal, or `source` the rc file(s) the
  command printed.
- **`rm -rf ~/.falcon` refuses to remove `access.key` cleanly / a process
  still has it open.** Re-run step 3 (`falcon daemon stop && falcon kill
  all-force`) first — a still-running daemon or session process can hold
  files under `~/.falcon` open, though this doesn't block `rm -rf` itself
  on POSIX (unlinking an open file just leaves the process holding it until
  it exits); if you want a completely clean slate before deleting, confirm
  `falcon doctor` reports no Falcon processes left first.
