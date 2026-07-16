/**
 * `falcon auth status` — reports the current local auth state. Deliberately
 * does not verify the stored JWT against the server (that would need a
 * network round trip this command doesn't otherwise make); it decodes the
 * token's claims for display only (see `jwt.ts`) and clearly labels the
 * expiry as unverified.
 */
import { decodeBase64, deriveKeyTree } from "@falcon/crypto";
import { credentialsPath, readCredentials } from "./credentials.js";
import { decodeTokenClaimsUnverified } from "./jwt.js";

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function runAuthStatus(): number {
  const credentials = readCredentials();
  if (!credentials) {
    process.stdout.write("Not logged in. Run `falcon auth login` to authenticate.\n");
    return 0;
  }

  process.stdout.write("Logged in.\n");
  process.stdout.write(`  Credentials file: ${credentialsPath()}\n`);

  // masterSecretOrContentBundle is exactly 32 raw bytes for a fully-paired
  // account (falcon-plan.md §2.1); anything else (a reduced content-key
  // bundle from a lower-trust pairing) can't derive a signing identity, so
  // this is best-effort display, not a schema assumption enforced elsewhere.
  const secret = decodeBase64(credentials.masterSecretOrContentBundle);
  if (secret.length === 32) {
    const { signing } = deriveKeyTree(secret);
    process.stdout.write(`  Account key: ${toHex(signing.publicKey).slice(0, 16)}…\n`);
  }

  const claims = decodeTokenClaimsUnverified(credentials.token);
  if (claims) {
    const expiresAt = new Date(claims.expiresAt * 1000);
    const label = expiresAt.getTime() < Date.now() ? "expired" : "expires";
    process.stdout.write(`  Token (unverified): ${label} ${expiresAt.toISOString()}\n`);
  } else {
    process.stdout.write("  Token: present (could not decode claims for display)\n");
  }

  return 0;
}
