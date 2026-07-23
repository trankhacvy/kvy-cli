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

// issue-4-plan.md §4.1/§8: stays 1h through Phase 1-5, flips to 15m in Phase 6 once web
// and CLI can silently refresh — a short TTL flip before those consumers exist would
// regress UX (forced re-login every 15 minutes).
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** The three surfaces that mint device sessions today (§3.2). Cloud sandboxes join later (§7). */
export type ClientKind = "web" | "cli-daemon" | "cli-session" | "cloud-sandbox";

// issue-4-plan.md §4.1: an access token now carries session-scoped claims — `sid`
// (device_sessions.id) and `ct` (clientKind) — not just the bare account id. This is what
// makes per-session revocation (§4.4/§4.5) and per-client-kind bookkeeping possible; a
// pre-issue-4 token has neither claim and is rejected by `verifyToken` below.
export interface TokenPayload {
  accountId: string;
  sessionId: string;
  clientKind: ClientKind;
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

function isClientKind(value: unknown): value is ClientKind {
  return (
    value === "web" || value === "cli-daemon" || value === "cli-session" || value === "cloud-sandbox"
  );
}

/**
 * Mint a short-lived access JWT for a `device_sessions` row. Stateless (no per-request DB
 * hit to verify) — revocation is enforced at refresh time and at the WS layer (§4.3/§4.5),
 * not by checking every access token against the database.
 */
export async function mintAccessToken(
  payload: TokenPayload,
  opts: TokenOptions = {},
): Promise<string> {
  const ttlSeconds = opts.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  const nowSeconds = Math.floor(Date.now() / 1000);

  return new SignJWT({ sid: payload.sessionId, ct: payload.clientKind })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(payload.accountId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ttlSeconds)
    .sign(signingKey(opts.secret));
}

/**
 * Verify a token and return its payload, or `null` if the token is missing, malformed,
 * tampered with, signed under a different secret, expired, or missing the `sid`/`ct`
 * claims every issue-4 token carries (a pre-issue-4 token, or a missed `mintAccessToken`
 * call site — reject rather than default, per §4.1). Mirrors the crypto package's "unwrap
 * never throws" rule (falcon-system-design.md §5.1) — an invalid token is an expected,
 * routine outcome (expiry, a stale client), not an exceptional one, so callers branch on
 * the return value instead of catching.
 */
export async function verifyToken(
  token: string,
  opts: TokenOptions = {},
): Promise<VerifiedToken | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, signingKey(opts.secret), {
      algorithms: [ALGORITHM],
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (typeof payload.exp !== "number") return null;
    if (typeof payload.sid !== "string" || payload.sid.length === 0) return null;
    if (!isClientKind(payload.ct)) return null;

    return {
      accountId: payload.sub,
      sessionId: payload.sid,
      clientKind: payload.ct,
      expiresAt: payload.exp,
    };
  } catch {
    // Any failure (bad signature, expired, malformed) collapses to null — see doc
    // comment above. jose's error subtypes aren't distinguished here on purpose: a
    // caller can't act differently on "expired" vs. "tampered", both mean "reject".
    return null;
  }
}
