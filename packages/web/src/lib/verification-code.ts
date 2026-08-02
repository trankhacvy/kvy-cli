/**
 * A 6-digit code derived from the requesting device's ephemeral public key, shown on both
 * screens of a key-sharing handshake.
 *
 * Defends against:
 *  1. Phishing via a stolen access token - attacker can make the card appear but cannot
 *     make their code match the victim's device.
 *  2. A relay substituting its own ephemeral key - requester shows the code for the key it
 *     generated, approver shows the code for the key the server delivered, so substitution
 *     makes them differ.
 *
 * Does NOT defend against a user who approves without looking.
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
