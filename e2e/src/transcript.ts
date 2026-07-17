/**
 * Read-side helpers: reconstruct a session's full, time-ordered
 * `SessionEnvelope[]` transcript from the real server (decrypting every
 * batch the `Outbox` posted), and poll it until some scripted expectation
 * shows up — the harness's way of observing what the `FakeSessionProcess`
 * did without any side-channel shortcut.
 */
import { open } from "@falcon/crypto";
import type { SessionEnvelope } from "@falcon/wire";
import type { TestStack } from "./testStack.js";

export async function fetchEnvelopes(
  stack: TestStack,
  sessionId: string,
): Promise<SessionEnvelope[]> {
  const tracked = stack.sessions.get(sessionId);
  if (!tracked) throw new Error(`fetchEnvelopes: unknown sessionId "${sessionId}"`);

  const batches = await stack.fetchMessageBatches(sessionId);
  const envelopes: SessionEnvelope[] = [];
  for (const batch of batches) {
    const opened = open<SessionEnvelope[]>(batch.content, tracked.dek);
    if (opened === null) {
      throw new Error(`fetchEnvelopes: failed to decrypt message batch seq=${batch.seq}`);
    }
    envelopes.push(...opened);
  }
  return envelopes;
}

/**
 * Polls the transcript until `predicate` matches an envelope, returning it.
 * Throws on timeout — every conformance step's assertions are meant to fail
 * loudly, never hang the harness silently.
 */
export async function waitForEnvelope(
  stack: TestStack,
  sessionId: string,
  predicate: (envelope: SessionEnvelope) => boolean,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<SessionEnvelope> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const envelopes = await fetchEnvelopes(stack, sessionId);
    const found = envelopes.find(predicate);
    if (found) return found;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForEnvelope: timed out after ${timeoutMs}ms waiting for a matching envelope`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Convenience: the newest still-pending `perm-request` for a given tool name (no matching `perm-resolve` yet). */
export function findPendingPermRequest(
  envelopes: SessionEnvelope[],
  toolName: string,
): Extract<SessionEnvelope["ev"], { t: "perm-request" }> | undefined {
  const resolved = new Set(
    envelopes
      .filter((e) => e.ev.t === "perm-resolve")
      .map((e) => (e.ev as { reqId: string }).reqId),
  );
  const requests = envelopes.filter(
    (e) => e.ev.t === "perm-request" && (e.ev as { name: string }).name === toolName,
  ) as { ev: Extract<SessionEnvelope["ev"], { t: "perm-request" }> }[];
  const pending = requests.filter((e) => !resolved.has(e.ev.reqId));
  return pending.at(-1)?.ev;
}

export async function waitForPendingPermRequest(
  stack: TestStack,
  sessionId: string,
  toolName: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<Extract<SessionEnvelope["ev"], { t: "perm-request" }>> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const envelopes = await fetchEnvelopes(stack, sessionId);
    const found = findPendingPermRequest(envelopes, toolName);
    if (found) return found;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForPendingPermRequest: timed out after ${timeoutMs}ms waiting for a pending perm-request for "${toolName}"`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
