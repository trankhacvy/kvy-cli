/**
 * CLI device-pairing client — port of Happy's `doAuth` pairing dance
 * (`happy-cli/src/ui/auth.ts`) onto Falcon's actual merged pairing routes
 * (`packages/server/src/app/api/pair.ts`; falcon-plan.md §2.2,
 * falcon-system-design.md §5.2 "CLI pairing"):
 *
 *   1. generate an ephemeral X25519 keypair (never persisted — lives only
 *      for the duration of this login attempt);
 *   2. POST /v1/auth/pair {ephPub} to create the pending request and print
 *      the pairing URL;
 *   3. poll GET /v1/auth/pair/status every 2s until it reports "authorized"
 *      or "expired" (that endpoint deliberately never returns secret
 *      material — see the server route's doc comment);
 *   4. once authorized, POST /v1/auth/pair once more to fetch the token and
 *      sealed box, then open the box with the ephemeral secret key
 *      (`libsodiumDecryptWithSecretKey`, the inverse of the approver's
 *      `libsodiumEncryptForPublicKey`) to recover the masterSecret.
 *
 * Every network call is wrapped so this module never throws — a failed
 * fetch, a malformed response, or a decrypt failure are all routine "this
 * attempt didn't work" outcomes the caller renders as a message, not bugs.
 */
import {
  decodeBase64,
  encodeBase64,
  encodeBase64Url,
  libsodiumDecryptWithSecretKey,
} from "@falcon/crypto";
import tweetnacl from "tweetnacl";
import { z } from "zod";

// Mirrors the server's hard 15-minute pairing TTL (pair.ts, PAIR_REQUEST_TTL_MS) — a
// safety net so a client that never sees an "expired" response (e.g. a network path
// that silently drops every poll) doesn't wait forever regardless.
const PAIRING_TIMEOUT_MS = 15 * 60 * 1000;

export interface PairOptions {
  backendUrl: string;
  frontendUrl: string;
  /** Called once with the pairing URL, before polling starts, so the caller can print/open/QR it. */
  onPairingUrlReady: (url: string) => void | Promise<void>;
  /** Poll interval, ms — falcon-plan.md §2.2 specifies 2s. */
  pollIntervalMs?: number;
  /** Lets the caller (e.g. a SIGINT handler) cancel an in-flight poll loop. */
  signal?: AbortSignal;
}

export interface PairSuccess {
  token: string;
  masterSecret: Uint8Array;
}

export type PairFailureReason = "request-failed" | "expired" | "cancelled" | "decrypt-failed";

export type PairOutcome =
  | { ok: true; result: PairSuccess }
  | { ok: false; reason: PairFailureReason };

const PairPostResponseSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }),
  z.object({ state: z.literal("expired") }),
  z.object({ state: z.literal("authorized"), token: z.string(), response: z.string() }),
]);
type PairPostResponse = z.infer<typeof PairPostResponseSchema>;

const PairStatusResponseSchema = z.object({
  status: z.enum(["not_found", "pending", "authorized", "expired"]),
});

async function postPair(backendUrl: string, ephPub: string): Promise<PairPostResponse | null> {
  try {
    const res = await fetch(`${backendUrl}/v1/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ephPub }),
    });
    if (!res.ok) return null;
    const parsed = PairPostResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function getPairStatus(
  backendUrl: string,
  ephPub: string,
): Promise<z.infer<typeof PairStatusResponseSchema> | null> {
  try {
    const res = await fetch(
      `${backendUrl}/v1/auth/pair/status?ephPub=${encodeURIComponent(ephPub)}`,
    );
    if (!res.ok) return null;
    const parsed = PairStatusResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function pairDevice(options: PairOptions): Promise<PairOutcome> {
  const { backendUrl, frontendUrl, onPairingUrlReady, pollIntervalMs = 2000, signal } = options;

  // Ephemeral X25519 keypair — the CLI's only key material for this login
  // attempt. Never written to disk; if the process dies mid-pairing, the
  // next `falcon auth login` simply starts over with a fresh one.
  const keypair = tweetnacl.box.keyPair();
  const ephPub = encodeBase64(keypair.publicKey);

  const created = await postPair(backendUrl, ephPub);
  if (!created) return { ok: false, reason: "request-failed" };
  if (created.state === "expired") return { ok: false, reason: "expired" };

  // falcon-plan.md §2.2: the pairing URL fragment carries the ephemeral
  // public key as base64url (URL-safe, no padding) — distinct from the
  // plain base64 the server's `/v1/auth/pair*` JSON bodies expect.
  const pairingUrl = `${frontendUrl}/pair#${encodeBase64Url(keypair.publicKey)}`;
  await onPairingUrlReady(pairingUrl);

  const deadline = Date.now() + PAIRING_TIMEOUT_MS;
  let state: PairPostResponse = created;

  while (state.state === "pending") {
    if (signal?.aborted) return { ok: false, reason: "cancelled" };
    if (Date.now() > deadline) return { ok: false, reason: "expired" };

    await delay(pollIntervalMs, signal);
    if (signal?.aborted) return { ok: false, reason: "cancelled" };

    const status = await getPairStatus(backendUrl, ephPub);
    if (!status || status.status === "not_found" || status.status === "pending") continue; // transient/unapproved — keep polling
    if (status.status === "expired") return { ok: false, reason: "expired" };

    // status.status === "authorized": /status never returns secret material
    // (see the server route), so fetch the token + sealed box via one more POST.
    const authorized = await postPair(backendUrl, ephPub);
    // Server-side expiry can race the last poll tick: GET /status said
    // "authorized" but by the time this POST lands the request has expired.
    // Surface that immediately rather than silently retrying until the
    // 15-minute PAIRING_TIMEOUT_MS deadline.
    if (authorized?.state === "expired") return { ok: false, reason: "expired" };
    if (authorized?.state !== "authorized") continue; // lost a race (e.g. request-failed) — retry next tick
    state = authorized;
  }

  if (state.state !== "authorized") return { ok: false, reason: "expired" };

  const sealedBox = decodeBase64(state.response);
  const masterSecret = libsodiumDecryptWithSecretKey(sealedBox, keypair.secretKey);
  if (!masterSecret) return { ok: false, reason: "decrypt-failed" };

  return { ok: true, result: { token: state.token, masterSecret } };
}
