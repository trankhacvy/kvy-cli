/**
 * Thin fetch wrappers for the auth-related endpoints these pages need
 * (`packages/server/src/app/routes/oauth.ts`, `routes/auth.ts`, `api/pair.ts`
 * — all already merged to main). No client-side schema validation library is
 * pulled in for this: the shapes are small and fixed, and a malformed
 * response surfaces as a thrown `ApiError` either way.
 */
import { API_URL } from "./config.js";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function postJson<T>(path: string, body: unknown, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Could not reach the Falcon server. Check your connection.", 0);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message =
      json && typeof json === "object" && "error" in json && typeof json.error === "string"
        ? json.error
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }

  return json as T;
}

/** `POST /v1/auth/register` — sign-up: binds a freshly-generated identity to an OAuth proof. */
export function register(body: {
  oauthProvider: "google" | "github";
  oauthProof: string;
  signPubKey: string;
  contentPubKey: string;
}): Promise<{ success: true; token: string }> {
  return postJson("/v1/auth/register", body);
}

/** `POST /v1/auth` — sign-in: proves possession of an already-provisioned identity. */
export function signIn(body: {
  publicKey: string;
  contentPublicKey: string;
  challenge: string;
  signature: string;
}): Promise<{ success: true; token: string }> {
  return postJson("/v1/auth", body);
}

/** `POST /v1/auth/oauth/github/exchange` — trades a GitHub authorization code for an access token. */
export function exchangeGithubCode(body: {
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string }> {
  return postJson("/v1/auth/oauth/github/exchange", body);
}

/** `POST /v1/auth/pair/approve` — an already-authenticated device approves a pairing request. */
export function approvePairing(
  token: string,
  body: { ephPub: string; response: string },
): Promise<{ success: true }> {
  return postJson("/v1/auth/pair/approve", body, token);
}
