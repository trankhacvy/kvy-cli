/**
 * Every network call is wrapped so this module never throws — a failed fetch, a
 * malformed response, or a decrypt failure are all routine outcomes the caller
 * renders as a message, not exceptions.
 */
import {
  decodeBase64,
  encodeBase64,
  encodeBase64Url,
  libsodiumDecryptWithSecretKey,
} from "@kvy/crypto";
import tweetnacl from "tweetnacl";
import { z } from "zod";

// Mirrors the server's hard 15-minute pairing TTL — safety net so a client that never
// sees an "expired" response (e.g. a network path that silently drops every poll)
// doesn't wait forever regardless.
const PAIRING_TIMEOUT_MS = 15 * 60 * 1000;

// Payload format: [version(1) | masterSecret(32) | refreshToken(rest)], matching
// web/src/crypto/worker-handler.ts's sealForPeer. v0 (no refresh token) is no longer
// minted; a v0 box would only come from a stale, already-expired pairing attempt.
const PAIR_PAYLOAD_VERSION = 0x01;
const MASTER_SECRET_LENGTH_BYTES = 32;

export interface PairOptions {
  backendUrl: string;
  frontendUrl: string;
  /** Called once with the pairing URL, before polling starts, so the caller can print/open/QR it. */
  onPairingUrlReady: (url: string) => void | Promise<void>;
  /** Poll interval in ms; defaults to 2s. */
  pollIntervalMs?: number;
  /** Lets the caller (e.g. a SIGINT handler) cancel an in-flight poll loop. */
  signal?: AbortSignal;
  /** Machine name shown on the approver's confirm card. Display only, never an auth input. */
  label?: string;
  /** Working directory shown on the approver's confirm card. Display only. */
  cwd?: string;
}

export interface PairSuccess {
  refreshToken: string;
  masterSecret: Uint8Array;
}

export type PairFailureReason = "request-failed" | "expired" | "cancelled" | "decrypt-failed";

export type PairOutcome =
  | { ok: true; result: PairSuccess }
  | { ok: false; reason: PairFailureReason };

const PairPostResponseSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }),
  z.object({ state: z.literal("expired") }),
  z.object({ state: z.literal("authorized"), response: z.string() }),
]);
type PairPostResponse = z.infer<typeof PairPostResponseSchema>;

const PairStatusResponseSchema = z.object({
  status: z.enum(["not_found", "pending", "authorized", "expired"]),
});

interface PairPostBody {
  ephPub: string;
  label?: string;
  cwd?: string;
}

async function postPair(backendUrl: string, body: PairPostBody): Promise<PairPostResponse | null> {
  try {
    const res = await fetch(`${backendUrl}/v1/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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

// Exported only so `pair.test.ts` can call it directly to assert the
// add/remove abort-listener counts stay balanced — every other caller still
// reaches it through `pairDevice`'s poll loop.
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Declared before `timer` so the timer callback below can remove this same
    // listener on the normal, non-aborted path too — `{ once: true }` alone only
    // unregisters it when `abort` actually fires, which leaves a dangling listener
    // on the long-lived, shared signal `pairDevice` reuses across every ~2s poll
    // tick for as long as ~450 ticks.
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pairDevice(options: PairOptions): Promise<PairOutcome> {
  const {
    backendUrl,
    frontendUrl,
    onPairingUrlReady,
    pollIntervalMs = 2000,
    signal,
    label,
    cwd,
  } = options;

  // Ephemeral — never written to disk; a mid-pairing failure just starts fresh
  // with a new keypair on the next login attempt.
  const keypair = tweetnacl.box.keyPair();
  const ephPub = encodeBase64(keypair.publicKey);
  const postBody: PairPostBody = { ephPub, label, cwd };

  const created = await postPair(backendUrl, postBody);
  if (!created) return { ok: false, reason: "request-failed" };
  if (created.state === "expired") return { ok: false, reason: "expired" };

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

    // /status never returns secret material (see the server route), so fetch the sealed
    // box via one more POST — single-use pickup: the server deletes the row the moment
    // this succeeds, so this exact response can never be re-served to a second poller.
    const authorized = await postPair(backendUrl, postBody);
    // Server-side expiry can race the last poll tick: GET /status said "authorized" but
    // by the time this POST lands the request has expired. Surface that immediately
    // rather than silently retrying until the PAIRING_TIMEOUT_MS deadline.
    if (authorized?.state === "expired") return { ok: false, reason: "expired" };
    if (authorized?.state !== "authorized") continue; // lost a race (e.g. request-failed) — retry next tick
    state = authorized;
  }

  if (state.state !== "authorized") return { ok: false, reason: "expired" };

  const sealedBox = decodeBase64(state.response);
  const payload = libsodiumDecryptWithSecretKey(sealedBox, keypair.secretKey);
  if (
    !payload ||
    payload.length <= 1 + MASTER_SECRET_LENGTH_BYTES ||
    payload[0] !== PAIR_PAYLOAD_VERSION
  ) {
    return { ok: false, reason: "decrypt-failed" };
  }
  const masterSecret = payload.slice(1, 1 + MASTER_SECRET_LENGTH_BYTES);
  const refreshToken = new TextDecoder().decode(payload.slice(1 + MASTER_SECRET_LENGTH_BYTES));
  if (!refreshToken) {
    return { ok: false, reason: "decrypt-failed" };
  }

  return { ok: true, result: { refreshToken, masterSecret } };
}
