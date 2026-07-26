/**
 * A 6-digit code derived from a requesting device's ephemeral public key, shown on BOTH
 * screens of a key-sharing handshake (docs/auth-ux-overhaul-plan.md §4.3).
 *
 * This is the control that replaces pairing's implicit co-presence proof (a human
 * physically opening a URL the CLI printed). Without it, an attacker holding only a
 * stolen access token could raise a key request and phish the approve card.
 *
 * What it defends against:
 *  1. Phishing via a stolen access token — the attacker can make the card appear, but
 *     cannot make their code match what the victim's own device shows.
 *  2. A malicious or compromised relay substituting its own ephemeral key: the requester
 *     shows the code for the key IT generated, the approver shows the code for the key the
 *     server delivered, so substitution makes them differ.
 *
 * What it does NOT defend against: a user who approves without looking. Hence the approve
 * button is labelled "Codes match — send my keys" rather than "Approve".
 */

export async function verificationCode(ephPub: string): Promise<string> {
  const bytes = new TextEncoder().encode(ephPub);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const value =
    (((digest[0] ?? 0) << 24) |
      ((digest[1] ?? 0) << 16) |
      ((digest[2] ?? 0) << 8) |
      (digest[3] ?? 0)) >>>
    0;
  return String(value % 1_000_000).padStart(6, "0");
}

/** "418 902" — grouped so two people can compare it across screens without losing place. */
export function formatVerificationCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
