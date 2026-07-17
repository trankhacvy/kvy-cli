/**
 * Path resolution for the FR-9.6 shell shim ("Tier 3 — make the problem
 * disappear", plan.md §16 "4.2 Adoption Tier 3 + polish", design §7.2:
 * "bin/ — optional shims (Tier 3 adoption): claude, codex → falcon").
 *
 * Two distinct home directories are in play here, so both are independently
 * overridable (test seams — never set in production):
 *  - `homeDir` — Falcon's own `~/.falcon` (or `FALCON_HOME_DIR`), where the
 *    shim binaries themselves live (`~/.falcon/bin/{claude,codex}`).
 *  - `userHomeDir` — the OS user's home directory (`os.homedir()`), where
 *    shell rc files (`.zshrc`, `.bashrc`, ...) live. These are unrelated:
 *    `FALCON_HOME_DIR` must never redirect rc-file writes, or tests (and
 *    multi-instance dev setups) that isolate `~/.falcon` would still touch
 *    a real shell rc file.
 */
import { homedir } from "node:os";
import path from "node:path";
import { resolveHomeDir } from "../home.js";

export interface ShimPathsOptions {
  /** Overrides `~/.falcon` (or `FALCON_HOME_DIR`) — where shim binaries live. */
  homeDir?: string;
  /** Overrides `os.homedir()` — where rc files are resolved under. Test seam only. */
  userHomeDir?: string;
  env?: NodeJS.ProcessEnv;
}

const SHIM_BINARY_NAMES = ["claude", "codex"] as const;
export type ShimBinaryName = (typeof SHIM_BINARY_NAMES)[number];

export type RcSyntax = "posix" | "fish";

export interface RcFileCandidate {
  path: string;
  syntax: RcSyntax;
}

export function shimBinaryNames(): readonly ShimBinaryName[] {
  return SHIM_BINARY_NAMES;
}

export function shimBinDir(options: ShimPathsOptions = {}): string {
  return path.join(options.homeDir ?? resolveHomeDir(options.env ?? process.env), "bin");
}

export function shimBinaryPath(name: ShimBinaryName, options: ShimPathsOptions = {}): string {
  return path.join(shimBinDir(options), name);
}

function resolveUserHomeDir(options: ShimPathsOptions): string {
  return options.userHomeDir ?? homedir();
}

/**
 * Every rc file `falcon shim status`/`uninstall` scans for the PATH block —
 * covers zsh, bash, fish, and the POSIX-universal login fallback
 * (`.profile`). Order matters only for `preferredRcFile`'s shell-name match
 * below; scanning itself checks all four regardless of the user's current
 * `$SHELL`, since it can differ between install and a later uninstall (e.g.
 * the user switched shells) — the block's markers make removal self-healing
 * regardless of which file(s) actually hold it.
 */
export function rcFileCandidates(options: ShimPathsOptions = {}): RcFileCandidate[] {
  const userHome = resolveUserHomeDir(options);
  return [
    { path: path.join(userHome, ".zshrc"), syntax: "posix" },
    { path: path.join(userHome, ".bashrc"), syntax: "posix" },
    { path: path.join(userHome, ".config", "fish", "config.fish"), syntax: "fish" },
    { path: path.join(userHome, ".profile"), syntax: "posix" },
  ];
}

/**
 * The single rc file `falcon shim install` writes its PATH block into,
 * picked from the user's login shell (`$SHELL`). Falls back to `.profile`
 * for an unrecognized/unset shell — every POSIX shell sources it on login.
 */
export function preferredRcFile(options: ShimPathsOptions = {}): RcFileCandidate {
  const candidates = rcFileCandidates(options);
  const shellPath = (options.env ?? process.env).SHELL;
  const shellName = shellPath ? path.basename(shellPath) : undefined;

  if (shellName === "zsh") return candidates[0] as RcFileCandidate;
  if (shellName === "bash") return candidates[1] as RcFileCandidate;
  if (shellName === "fish") return candidates[2] as RcFileCandidate;
  return candidates[3] as RcFileCandidate; // .profile
}
