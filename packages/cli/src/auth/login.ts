import os from "node:os";
import { z } from "zod";
import { resolveHomeDir } from "../home.js";
import type { Logger } from "../logger.js";
import {
  connectedAs,
  NO_TTY_CANNOT_SIGN_IN,
  OPENING_BROWSER,
  STARTING_SESSION,
  WAITING_FOR_APPROVAL,
  WELCOME_FIRST_RUN,
  webUrlLine,
} from "../ui/messages.js";
import { openBrowser } from "./browser.js";
import { resolveBackendUrl, resolveFrontendUrl } from "./config.js";
import {
  clearCredentials,
  type KvyCredentials,
  readCredentials,
  writeCredentials,
} from "./credentials.js";
import { wrapNewKeyMaterial } from "./keyMaterial.js";
import { type PairFailureReason, pairDevice } from "./pair.js";
import { displayQrCode } from "./qrcode.js";
import { resolveAccessToken } from "./resolveAccessToken.js";

const SessionsResponseSchema = z.object({ email: z.string().nullable() });

/**
 * Deliberately reads account email from the AUTHENTICATED `GET /v1/auth/sessions`
 * rather than the unauthenticated pairing routes: anyone holding a pairing URL could
 * otherwise read the account's email off `/v1/auth/pair/status` without proving they
 * hold the matching ephemeral secret key.
 *
 * Best-effort — a failure just drops the name from one success line.
 */
async function fetchAccountEmail(
  credentials: KvyCredentials,
  backendUrl: string,
): Promise<string | null> {
  try {
    const token = await resolveAccessToken(credentials, { backendUrl });
    if (!token) return null;
    const res = await fetch(`${backendUrl}/v1/auth/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const parsed = SessionsResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.email : null;
  } catch {
    return null;
  }
}

/**
 * `force: true` means the caller has already proved this machine's stored refresh token
 * is dead (a real 401 from `POST /v1/auth/refresh`), so the credentials file on disk is
 * worthless and must not be mistaken for being signed in. Revocation from Settings →
 * Devices is server-side only: `access.key` survives it untouched. Without this flag,
 * the existing-credentials check short-circuits and the inline re-pair path never runs.
 */
export interface EnsureLoggedInOptions {
  force?: boolean;
}

export async function ensureLoggedIn(
  logger: Logger,
  homeDir: string = resolveHomeDir(),
  options: EnsureLoggedInOptions = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!options.force && readCredentials(homeDir)) return { ok: true };

  if (process.stdin.isTTY !== true) {
    return { ok: false, message: NO_TTY_CANNOT_SIGN_IN };
  }

  // Only now, with a TTY confirmed and pairing actually about to start, is it safe to drop
  // the dead credentials — a Ctrl-C at the QR code then leaves the machine exactly as it
  // was rather than worse off.
  if (options.force) clearCredentials(homeDir);

  const code = await runAuthLogin(logger, homeDir);
  return code === 0 ? { ok: true } : { ok: false, message: "" };
}

function describeFailure(reason: PairFailureReason): string {
  switch (reason) {
    case "request-failed":
      return "Could not reach the Kvy server. Check your network connection, then try again.";
    case "expired":
      return "That sign-in link expired before it was approved. Starting over will get you a fresh one.";
    case "cancelled":
      return "Sign-in cancelled.";
    case "decrypt-failed":
      return "Received an unreadable response from the server. Please try again.";
  }
}

export async function runAuthLogin(
  logger: Logger,
  homeDir: string = resolveHomeDir(),
): Promise<number> {
  const backendUrl = resolveBackendUrl();
  const frontendUrl = resolveFrontendUrl();

  process.stdout.write(WELCOME_FIRST_RUN);
  logger.info("auth login: starting pairing", { backendUrl, frontendUrl });

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);

  try {
    const outcome = await pairDevice({
      backendUrl,
      frontendUrl,
      signal: controller.signal,
      label: os.hostname(),
      cwd: process.cwd(),
      onPairingUrlReady: async (url) => {
        process.stdout.write(OPENING_BROWSER);
        await openBrowser(url);
        process.stdout.write(webUrlLine(url));
        displayQrCode(url);
        process.stdout.write(WAITING_FOR_APPROVAL);
      },
    });

    if (!outcome.ok) {
      logger.warn("auth login: pairing did not complete", { reason: outcome.reason });
      process.stdout.write(`\n${describeFailure(outcome.reason)}\n`);
      return 1;
    }

    // Always device-key wrap — no PIN prompt. Works unattended (the daemon needs this)
    // and avoids prompting for a PIN on every `kvy claude` invocation.
    const keyMaterial = await wrapNewKeyMaterial(outcome.result.masterSecret, homeDir);
    const credentials: KvyCredentials = {
      refreshToken: outcome.result.refreshToken,
      keyMaterial,
    };
    writeCredentials(credentials, homeDir);

    logger.info("auth login: succeeded");
    process.stdout.write(connectedAs(await fetchAccountEmail(credentials, backendUrl)));
    process.stdout.write(STARTING_SESSION);
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
