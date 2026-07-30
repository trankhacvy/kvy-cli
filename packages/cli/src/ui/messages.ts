/**
 * Every user-facing string the CLI prints during auth/first-run
 * (docs/auth-ux-overhaul-plan.md Phase 0). Centralised so the "no jargon, no
 * 'go run this yourself'" rules can be enforced in one place and asserted in
 * one test (`__tests__/messages.test.ts`).
 */

export const WELCOME_FIRST_RUN =
  "\n  Welcome to Falcon.\n  Let's connect this machine to your account.\n\n";

export const OPENING_BROWSER = "  Opening your browser…\n";

export function pairingUrlFallback(url: string): string {
  return `  If it didn't open, go to:\n  ${url}\n\n`;
}

export const WAITING_FOR_APPROVAL = "  Waiting for approval…  (Ctrl-C to cancel)\n";

export function connectedAs(email: string | null): string {
  return email ? `\n  ✓ Connected as ${email}\n` : "\n  ✓ Connected\n";
}

export const RECONNECTING = "\n  Your session expired. Reconnecting…\n";

export const STARTING_SESSION = "  Starting your session…\n\n";

/**
 * The only hard-fail on the not-signed-in path: there is genuinely no human at
 * this terminal to complete a browser sign-in.
 *
 * Keeps the literal substring "not logged in" — `commands/start.test.ts`
 * asserts on it, and rewording without updating that test is a silent break.
 */
export const NO_TTY_CANNOT_SIGN_IN =
  "falcon: not logged in, and there's no terminal here to sign in from.\n" +
  "Run `falcon auth login` on a machine with a browser, then try again.\n";

/**
 * Stored key material can't produce a content key — a reduced-custody pairing
 * bundle, or (pre-Phase-5 credentials) a PIN unlock that didn't succeed.
 */
export const REDUCED_CUSTODY =
  "falcon: this machine's stored keys can't unlock your sessions.\n" +
  "Connect it again from a device that has your keys.\n";

export const MACHINE_NOT_REGISTERED =
  "falcon: this machine hasn't finished connecting yet. Try again in a few seconds.\n";

export const NETWORK_UNREACHABLE =
  "falcon: couldn't reach the Falcon server. Check your connection and try again.\n";

/**
 * Printed on exit when a key request arrived during the session — the durable half of
 * Fix 7's notification (the live half is an OSC 9 desktop notification, which not every
 * terminal supports). Mentions no command: the exit path runs the approve review itself
 * (principle 1) when a human is present, so there is nothing to tell the user to go run.
 */
export const KEY_REQUEST_PENDING =
  "\n  A device asked for a copy of your keys while you were working.\n";
