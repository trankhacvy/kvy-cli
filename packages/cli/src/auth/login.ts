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
import { encodeBase64 } from "@falcon/crypto";
import type { Logger } from "../logger.js";
import { openBrowser } from "./browser.js";
import { resolveBackendUrl, resolveFrontendUrl } from "./config.js";
import { writeCredentials } from "./credentials.js";
import { type PairFailureReason, pairDevice } from "./pair.js";
import { displayPairingQrCode } from "./qrcode.js";

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

    writeCredentials({
      refreshToken: outcome.result.refreshToken,
      masterSecretOrContentBundle: encodeBase64(outcome.result.masterSecret),
    });

    logger.info("auth login: succeeded");
    process.stdout.write("\nLogged in to Falcon.\n");
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
