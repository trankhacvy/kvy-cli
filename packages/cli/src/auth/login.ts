/**
 * `falcon auth login` — port of Happy's `doWebAuth`/`waitForAuthentication`
 * (`happy-cli/src/ui/auth.ts`), collapsed onto Falcon's single web-app
 * pairing target (falcon-plan.md §5/§2.2): the CLI always prints the pairing
 * URL and a QR code, and *additionally* tries to open it in a browser
 * automatically — the "OAuth browser flow" is just that URL, since the web
 * app (not the CLI) is what talks to Google/GitHub and already holds the
 * account's keys once signed in there. Opening the browser is best-effort;
 * the printed URL/QR is the fallback that always works, including headless
 * environments (matches Happy's "I changed this to always show the URL"
 * fix for devcontainers).
 */
import os from "node:os";
import { z } from "zod";
import { resolveHomeDir } from "../home.js";
import type { Logger } from "../logger.js";
import {
  connectedAs,
  NO_TTY_CANNOT_SIGN_IN,
  OPENING_BROWSER,
  pairingUrlFallback,
  STARTING_SESSION,
  WAITING_FOR_APPROVAL,
  WELCOME_FIRST_RUN,
} from "../ui/messages.js";
import { openBrowser } from "./browser.js";
import { resolveBackendUrl, resolveFrontendUrl } from "./config.js";
import {
  clearCredentials,
  type FalconCredentials,
  readCredentials,
  writeCredentials,
} from "./credentials.js";
import { wrapNewKeyMaterial } from "./keyMaterial.js";
import { type PairFailureReason, pairDevice } from "./pair.js";
import { displayPairingQrCode } from "./qrcode.js";
import { resolveAccessToken } from "./resolveAccessToken.js";

const SessionsResponseSchema = z.object({ email: z.string().nullable() });

/**
 * The account this device just joined, for the "✓ Connected as …" line.
 *
 * Deliberately read from the AUTHENTICATED `GET /v1/auth/sessions` (which already
 * returns it) rather than from the unauthenticated pairing routes: anyone holding a
 * pairing URL could otherwise read the account's email off `/v1/auth/pair/status`
 * without ever proving they hold the matching ephemeral secret key.
 *
 * Best-effort — a failure just drops the name from one success line.
 */
async function fetchAccountEmail(
  credentials: FalconCredentials,
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
 * First-run UX (plan.md §16 PRD FR-1.2's "no separate setup steps" goal, extended to
 * auth): `falcon claude` shouldn't hard-fail with an instruction to run a second command
 * when nobody's logged in yet — if a human is actually present at this terminal (a real
 * TTY), just run the same pairing flow `falcon auth login` uses, inline, then let the
 * caller continue straight into the session. A non-interactive invocation (CI, a
 * headless script) has no one to show a QR code to, so that case keeps the old, honest
 * hard-fail instead of hanging.
 */
/**
 * `force: true` means the CALLER has already proved this machine's stored refresh token is
 * dead (a real 401 from `POST /v1/auth/refresh` — see `startPreflight.ts`'s `isDead` check),
 * so the credentials file on disk is worthless and must not be mistaken for being signed in.
 *
 * Revocation from Settings → Devices is server-side only: `access.key` survives it untouched.
 * Without this flag, the first line below short-circuits and the entire "dead token → inline
 * re-pair" path (AX-1.5) never runs — auth-ux-overhaul-e2e-results.md E2E-6.4, which
 * reproduced 100% of the time.
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
  // `runAuthLogin` already wrote a full explanation of what went wrong to stdout —
  // nothing further to say here, just propagate the failure.
  return code === 0 ? { ok: true } : { ok: false, message: "" };
}

function describeFailure(reason: PairFailureReason): string {
  switch (reason) {
    case "request-failed":
      return "Could not reach the Falcon server. Check FALCON_BACKEND_URL and your network, then try again.";
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
        const opened = await openBrowser(url);
        if (!opened) process.stdout.write(pairingUrlFallback(url));
        displayPairingQrCode(url);
        process.stdout.write(WAITING_FOR_APPROVAL);
      },
    });

    if (!outcome.ok) {
      logger.warn("auth login: pairing did not complete", { reason: outcome.reason });
      process.stdout.write(`\n${describeFailure(outcome.reason)}\n`);
      return 1;
    }

    // issue-4-plan.md §6.1/§6.5, revised: always device-key wrap — no PIN prompt for the
    // CLI, interactive or not. Works unattended (the daemon needs exactly that) and
    // avoids asking a human to type a PIN on every future `falcon claude` invocation.
    const keyMaterial = await wrapNewKeyMaterial(outcome.result.masterSecret, homeDir);
    const credentials: FalconCredentials = {
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
