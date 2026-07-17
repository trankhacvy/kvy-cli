/**
 * Short-lived HMAC tokens authorizing one PUT or GET against the local-disk
 * driver's `/v1/blobs/local/:id` sink (`localDriver.ts`, `app/routes/
 * blobs.ts`) — the local-disk equivalent of an S3 presigned URL's SigV4
 * signature: everything the caller needs is embedded in the URL itself, no
 * separate `Authorization` bearer step required.
 *
 * Deliberately hand-rolled instead of pulling in a JWT library — the claim
 * set is three fixed fields and the only consumer is this same server, so a
 * constant-time HMAC compare is the whole trust boundary; a JWT would add a
 * parsing/algorithm-confusion surface for no benefit here.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type BlobTokenOp = "upload" | "download";

function sign(secret: string, op: BlobTokenOp, key: string, exp: number): string {
  return createHmac("sha256", secret).update(`${op}:${key}:${exp}`).digest("hex");
}

/** Mints `{token, exp}` for one `op` against blob `key`, valid for `ttlSeconds` from now. */
export function signBlobToken(
  secret: string,
  op: BlobTokenOp,
  key: string,
  ttlSeconds: number,
): { token: string; exp: number } {
  const exp = Date.now() + ttlSeconds * 1000;
  return { token: sign(secret, op, key, exp), exp };
}

/**
 * Verifies a `(token, exp)` pair for `op`/`key`. Never throws — every
 * failure mode (expired, malformed, wrong signature) is just "not
 * authorized," so the route handler always gets a clean boolean to 401 on.
 */
export function verifyBlobToken(
  secret: string,
  op: BlobTokenOp,
  key: string,
  exp: number,
  token: string,
): boolean {
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = sign(secret, op, key, exp);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(token, "hex");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
