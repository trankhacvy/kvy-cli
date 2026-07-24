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
import { resolveHomeDir } from "../home.js";
import type { Logger } from "../logger.js";
import { openBrowser } from "./browser.js";
import { resolveBackendUrl, resolveFrontendUrl } from "./config.js";
import { readCredentials, writeCredentials } from "./credentials.js";
import { wrapNewKeyMaterial } from "./keyMaterial.js";
import { type PairFailureReason, pairDevice } from "./pair.js";
import { displayPairingQrCode } from "./qrcode.js";

const NOT_LOGGED_IN_MESSAGE = 'falcon: not logged in — run "falcon auth login" first\n';

/**
 * First-run UX (plan.md §16 PRD FR-1.2's "no separate setup steps" goal, extended to
 * auth): `falcon claude` shouldn't hard-fail with an instruction to run a second command
 * when nobody's logged in yet — if a human is actually present at this terminal (a real
 * TTY), just run the same pairing flow `falcon auth login` uses, inline, then let the
 * caller continue straight into the session. A non-interactive invocation (CI, a
 * headless script) has no one to show a QR code to, so that case keeps the old, honest
 * hard-fail instead of hanging.
 */
export async function ensureLoggedIn(
  logger: Logger,
  homeDir: string = resolveHomeDir(),
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (readCredentials(homeDir)) return { ok: true };

  if (process.stdin.isTTY !== true) {
    return { ok: false, message: NOT_LOGGED_IN_MESSAGE };
  }

  process.stdout.write("You're not logged in yet — let's get you set up.\n");
  const code = await runAuthLogin(logger);
  // `runAuthLogin` already wrote a full explanation of what went wrong to stdout —
  // nothing further to say here, just propagate the failure.
  return code === 0 ? { ok: true } : { ok: false, message: "" };
}

function describeFailure(reason: PairFailureReason): string {
  switch (reason) {
    case "request-failed":
      return "Could not reach the Falcon server. Check FALCON_BACKEND_URL and your network, then try again.";
    case "expired":
      return "Pairing request expired before it was approved. Run `falcon auth login` again.";
    case "cancelled":
      return "Sign-in cancelled.";
    case "decrypt-failed":
      return "Received an unreadable response from the server. Please try again.";
  }
}

export async function runAuthLogin(logger: Logger): Promise<number> {
  const backendUrl = resolveBackendUrl();
  const frontendUrl = resolveFrontendUrl();

  process.stdout.write("Signing in to Falcon...\n");
  logger.info("auth login: starting pairing", { backendUrl, frontendUrl });

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);

  try {
    const outcome = await pairDevice({
      backendUrl,
      frontendUrl,
      signal: controller.signal,
      onPairingUrlReady: async (url) => {
        process.stdout.write("\nOpen this URL to finish signing in:\n");
        process.stdout.write(`  ${url}\n\n`);
        displayPairingQrCode(url);

        const opened = await openBrowser(url);
        process.stdout.write(
          opened
            ? "Opened your browser — complete sign-in there.\n"
            : "Could not open a browser automatically — use the URL or QR code above.\n",
        );
        process.stdout.write("Waiting for approval (Ctrl-C to cancel)...\n");
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
    const keyMaterial = await wrapNewKeyMaterial(outcome.result.masterSecret, resolveHomeDir());
    writeCredentials({ refreshToken: outcome.result.refreshToken, keyMaterial });

    logger.info("auth login: succeeded");
    process.stdout.write("\nLogged in to Falcon.\n");
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
