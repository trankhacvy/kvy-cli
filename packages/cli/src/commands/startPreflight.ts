/**
 * Everything a provider command must resolve from stored credentials before a
 *
 * Extracted so the dead-refresh-token path can re-run it WHOLESALE after an
 * inline re-pair: a new pairing can change the account's key epoch, so
 * `masterSecret`/`contentKeyPair`/`machineId` are all potentially stale
 * afterwards. Patching only the access token would silently encrypt the whole
 * session under a dead key.
 *
 * Shared by `commands/start.ts` (claude) and `commands/startCodex.ts`.
 */
import { deriveKeyTree, type KeyTree } from "@kvy/crypto";
import type { KvyCredentials } from "../auth/credentials.js";
import { resolveKeyMaterial } from "../auth/keyMaterial.js";
import { createTokenProviderForCredentials } from "../auth/resolveAccessToken.js";
import type { TokenProvider } from "../auth/tokenProvider.js";
import type { DaemonState } from "../daemon/state.js";
import type { Logger } from "../logger.js";
import {
  MACHINE_NOT_REGISTERED,
  NETWORK_UNREACHABLE,
  NO_TTY_CANNOT_SIGN_IN,
  RECONNECTING,
  REDUCED_CUSTODY,
} from "../ui/messages.js";

const MASTER_SECRET_LENGTH_BYTES = 32;
const MACHINE_ID_WAIT_TIMEOUT_MS = 3000;
const MACHINE_ID_POLL_MS = 100;

export interface Preflight {
  credentials: KvyCredentials;
  masterSecret: Uint8Array;
  contentKeyPair: KeyTree["content"];
  workspaceIndexKey: KeyTree["workspaceIndexKey"];
  machineId: string;
  tokenProvider: TokenProvider;
  accessToken: string;
}

export type PreflightResult =
  | { ok: true; preflight: Preflight }
  /** The stored refresh token is dead — the caller may re-pair and retry. */
  | { ok: false; reason: "needs-reauth" }
  | { ok: false; reason: "error"; message: string };

export interface PreflightDeps {
  homeDir: string;
  backendUrl: string;
  readCredentials: (homeDir: string) => KvyCredentials | null;
  readDaemonState: (homeDir: string) => Promise<DaemonState | null>;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  logger: Logger;
  /** `process.stdin.isTTY === true` in production; injectable so tests can drive both paths. */
  interactive: boolean;
}

/**
 * Waits (briefly) for the daemon to have persisted a `machineId`. Returns
 * `null` on timeout rather than throwing.
 */
async function waitForMachineId(deps: PreflightDeps): Promise<string | null> {
  const deadline = deps.now() + MACHINE_ID_WAIT_TIMEOUT_MS;
  for (;;) {
    const state = await deps.readDaemonState(deps.homeDir);
    if (state?.machineId) return state.machineId;
    if (deps.now() >= deadline) return null;
    await deps.sleep(MACHINE_ID_POLL_MS);
  }
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightResult> {
  const credentials = deps.readCredentials(deps.homeDir);
  if (!credentials) return { ok: false, reason: "error", message: NO_TTY_CANNOT_SIGN_IN };

  const masterSecret = await resolveKeyMaterial(
    credentials.keyMaterial,
    deps.homeDir,
    deps.interactive ? {} : undefined,
  );
  if (!masterSecret || masterSecret.length !== MASTER_SECRET_LENGTH_BYTES) {
    return { ok: false, reason: "error", message: REDUCED_CUSTODY };
  }
  const { content: contentKeyPair, workspaceIndexKey } = deriveKeyTree(masterSecret);

  const machineId = await waitForMachineId(deps);
  if (!machineId) return { ok: false, reason: "error", message: MACHINE_NOT_REGISTERED };

  const tokenProvider = createTokenProviderForCredentials(credentials, {
    backendUrl: deps.backendUrl,
    homeDir: deps.homeDir,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
  });
  const accessToken = await tokenProvider.getAccessToken();
  if (!accessToken) {
    return tokenProvider.isDead
      ? { ok: false, reason: "needs-reauth" }
      : { ok: false, reason: "error", message: NETWORK_UNREACHABLE };
  }

  return {
    ok: true,
    preflight: {
      credentials,
      masterSecret,
      contentKeyPair,
      workspaceIndexKey,
      machineId,
      tokenProvider,
      accessToken,
    },
  };
}

export interface PreflightWithReauthDeps extends PreflightDeps {
  ensureLoggedIn: (
    logger: Logger,
    homeDir: string,
    options?: { force?: boolean },
  ) => Promise<{ ok: boolean; message?: string }>;
  /** Ask a running daemon to re-read `access.key` and re-register its machine. */
  reloadDaemonAuth: (homeDir: string) => Promise<boolean>;
  write: (text: string) => void;
}

/**
 * `runPreflight`, plus one inline re-pair attempt when the stored refresh token
 * turns out to be dead. Never tells the user to run a command it can run itself
 * — the only hard failure is "there is no terminal here to sign in from".
 */
export async function runPreflightWithReauth(
  deps: PreflightWithReauthDeps,
): Promise<PreflightResult> {
  const first = await runPreflight(deps);
  if (first.ok || first.reason !== "needs-reauth") return first;

  if (!deps.interactive) {
    return { ok: false, reason: "error", message: NO_TTY_CANNOT_SIGN_IN };
  }

  deps.write(RECONNECTING);
  // `force`: we got here because `runPreflight` above saw a real 401 on the stored refresh
  // token. The credentials FILE still exists (web revocation never deletes it), so without
  // this the helper reports "already signed in" and no pairing ever starts.
  const auth = await deps.ensureLoggedIn(deps.logger, deps.homeDir, { force: true });
  if (!auth.ok) {
    return { ok: false, reason: "error", message: auth.message || NO_TTY_CANNOT_SIGN_IN };
  }

  // A fresh pairing mints a new device session; the daemon is still holding the
  // old one, so `waitForMachineId` would otherwise resolve against a machine
  // row the new session can no longer write to.
  await deps.reloadDaemonAuth(deps.homeDir);

  const second = await runPreflight(deps);
  if (!second.ok && second.reason === "needs-reauth") {
    return { ok: false, reason: "error", message: NO_TTY_CANNOT_SIGN_IN };
  }
  return second;
}
