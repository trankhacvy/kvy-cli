import { jwtVerify, SignJWT } from "jose";
import { env } from "../config.js";

// Signing algorithm decision (falcon-plan.md §16 "0.4 Server foundation"): HMAC (HS256),
// not RS256. Rationale: Falcon MVP is a single server process minting and verifying its
// own tokens — there's no third party that needs to verify a token without holding the
// signing secret, which is the scenario RS256's asymmetric split exists for. HS256 is
// simpler (one secret, no keypair/rotation machinery) and is what falcon-plan.md §4.4 and
// §16 both specify: "short-lived JWT (jose, HS256 from FALCON_MASTER_SECRET at MVP)".
// Revisit if/when a separate verifier service (e.g. a CDN edge check) needs to verify
// tokens without the mint secret — that's the point RS256 would earn its complexity.
const ALGORITHM = "HS256";

// falcon-system-design.md §5.2: "JWT (1 h, auto-refresh)" — replaces Happy's persistent
// tokens (falcon-plan.md §4.4 delta D5). Auto-refresh is a client-side concern (re-mint
// before expiry); this module only enforces the lifetime.
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

// The account identity anchor (falcon-system-design.md §6.1: accounts.id). Deliberately
// minimal — this module is DB-agnostic (per task scope) and knows nothing about the
// `accounts` table beyond the id string it's handed.
export interface TokenPayload {
  accountId: string;
}

export interface VerifiedToken extends TokenPayload {
  /** Epoch seconds the token expires at (JWT `exp` claim). */
  expiresAt: number;
}

export interface TokenOptions {
  /** Overrides `env.FALCON_MASTER_SECRET` — mainly for test isolation. */
  secret?: string;
  /** Overrides `ACCESS_TOKEN_TTL_SECONDS` — mainly for test isolation. */
  ttlSeconds?: number;
}

function signingKey(secret?: string): Uint8Array {
  return new TextEncoder().encode(secret ?? env.FALCON_MASTER_SECRET);
}

/**
 * Mint a short-lived JWT for `accountId`. The token carries no other claims — session,
 * device, and permission state all live server-side, keyed off the account id, so the
 * token itself stays a thin, low-value bearer credential.
 */
export async function mintToken(accountId: string, opts: TokenOptions = {}): Promise<string> {
  const ttlSeconds = opts.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  const nowSeconds = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(accountId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ttlSeconds)
    .sign(signingKey(opts.secret));
}

/**
 * Verify a token and return its payload, or `null` if the token is missing, malformed,
 * tampered with, signed under a different secret, or expired. Mirrors the crypto
 * package's "unwrap never throws" rule (falcon-system-design.md §5.1) — an invalid
 * token is an expected, routine outcome (expiry, a stale client), not an exceptional
 * one, so callers branch on the return value instead of catching.
 */
export async function verifyToken(token: string, opts: TokenOptions = {}): Promise<VerifiedToken | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, signingKey(opts.secret), {
      algorithms: [ALGORITHM],
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (typeof payload.exp !== "number") return null;

    return { accountId: payload.sub, expiresAt: payload.exp };
  } catch {
    // Any failure (bad signature, expired, malformed) collapses to null — see doc
    // comment above. jose's error subtypes aren't distinguished here on purpose: a
    // caller can't act differently on "expired" vs. "tampered", both mean "reject".
    return null;
  }
}
