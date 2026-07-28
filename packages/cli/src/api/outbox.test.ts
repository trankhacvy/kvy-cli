import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRandomBytes, open } from "@falcon/crypto";
import { createEnvelope, type EncryptedBox, type SessionEnvelope } from "@falcon/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "../logger.js";
import { createHttpClient, type OutboxHttpClient, type OutboxPostResult } from "./httpClient.js";
import { DEFAULT_FLUSH_MS, DEFAULT_MAX_BATCH_SIZE, Outbox } from "./outbox.js";
import { outboxQueuePath } from "./queue.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function textEnvelope(md: string): SessionEnvelope {
  return createEnvelope("agent", { t: "text", md });
}

/** Records every call and resolves/throws per a scripted plan; supports unlimited extra calls past the script (repeats the last entry). */
type PlanEntry = { ok: boolean; status: number } | { throws: true };

function scriptedHttpClient(plan: PlanEntry[]): {
  client: OutboxHttpClient;
  calls: { sessionId: string; localId: string }[];
} {
  const calls: { sessionId: string; localId: string }[] = [];
  return {
    calls,
    client: {
      async postMessages(sessionId, body): Promise<OutboxPostResult> {
        const idx = Math.min(calls.length, plan.length - 1);
        const entry = plan[idx]!;
        calls.push({ sessionId, localId: body.localId });
        if ("throws" in entry) {
          throw new Error("simulated network failure");
        }
        return { ok: entry.ok, status: entry.status };
      },
    },
  };
}

function alwaysOkClient(): {
  client: OutboxHttpClient;
  calls: { sessionId: string; localId: string }[];
} {
  return scriptedHttpClient([{ ok: true, status: 200 }]);
}

describe("Outbox", () => {
  let homeDir: string;
  let outboxes: Outbox[];

  beforeEach(async () => {
    homeDir = join(tmpdir(), `outbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(homeDir, { recursive: true });
    outboxes = [];
  });

  afterEach(async () => {
    for (const ob of outboxes) ob.dispose();
    if (existsSync(homeDir)) await rm(homeDir, { recursive: true, force: true });
  });

  function makeOutbox(
    opts: Partial<ConstructorParameters<typeof Outbox>[0]> & {
      http: OutboxHttpClient;
      dek: Uint8Array;
    },
  ): Outbox {
    const ob = new Outbox({
      sessionId: "sess-1",
      homeDir,
      logger: silentLogger(),
      ...opts,
    });
    outboxes.push(ob);
    return ob;
  }

  describe("coalescing thresholds", () => {
    it("flushes immediately once maxBatchSize envelopes have queued, without waiting for the timer", async () => {
      const dek = getRandomBytes(32);
      const { client, calls } = alwaysOkClient();
      const ob = makeOutbox({ dek, http: client, maxBatchSize: 5, flushMs: 60_000 });

      ob.enqueue([textEnvelope("1"), textEnvelope("2"), textEnvelope("3"), textEnvelope("4")]);
      expect(ob.bufferedCount).toBe(4);
      expect(ob.queuedBatchCount).toBe(0);

      ob.enqueue([textEnvelope("5")]); // hits the count threshold — flush is synchronous
      expect(ob.bufferedCount).toBe(0);
      expect(ob.queuedBatchCount).toBe(1); // sealed and queued synchronously by flush()

      // Let the (already-armed) async drain/send resolve.
      await sleep(20);
      expect(calls.length).toBe(1);
      expect(ob.queuedBatchCount).toBe(0); // acked and dequeued
    });

    it("flushes after flushMs elapses even when the count threshold is never reached", async () => {
      const dek = getRandomBytes(32);
      const { client, calls } = alwaysOkClient();
      const ob = makeOutbox({
        dek,
        http: client,
        maxBatchSize: DEFAULT_MAX_BATCH_SIZE,
        flushMs: 40,
      });

      ob.enqueue([textEnvelope("only one")]);
      expect(ob.bufferedCount).toBe(1);
      expect(calls.length).toBe(0);

      // Before the timer fires, nothing has been sealed yet.
      await sleep(15);
      expect(ob.bufferedCount).toBe(1);
      expect(calls.length).toBe(0);

      // After flushMs, the timer fires and the batch is sealed + sent.
      await sleep(60);
      expect(ob.bufferedCount).toBe(0);
      expect(calls.length).toBe(1);
    });

    it("uses the documented defaults (150ms / 20 events) when not overridden", () => {
      expect(DEFAULT_FLUSH_MS).toBe(150);
      expect(DEFAULT_MAX_BATCH_SIZE).toBe(20);
    });

    it("dispose() flushes whatever's still buffered so it survives on disk instead of being silently dropped", () => {
      const dek = getRandomBytes(32);
      const { client } = alwaysOkClient();
      const sessionId = "sess-dispose-flush";
      const ob = makeOutbox({
        sessionId,
        dek,
        http: client,
        maxBatchSize: DEFAULT_MAX_BATCH_SIZE, // never hit by count
        flushMs: 60_000, // never hit by timer within this test
      });

      ob.enqueue([textEnvelope("still buffered")]);
      expect(ob.bufferedCount).toBe(1);

      ob.dispose();

      expect(ob.bufferedCount).toBe(0);
      expect(ob.queuedBatchCount).toBe(1); // sealed + persisted, not dropped
      expect(existsSync(outboxQueuePath(homeDir, sessionId))).toBe(true);
    });
  });

  describe("disk persistence / replay across a simulated restart", () => {
    it("survives a crash: an unacked batch is reloaded from disk and successfully sent by a new instance", async () => {
      const dek = getRandomBytes(32);
      const sessionId = "sess-restart";

      // Instance A: the server is unreachable, so the flushed batch never gets acked.
      const failing = scriptedHttpClient([{ throws: true }]);
      const obA = new Outbox({
        sessionId,
        homeDir,
        dek,
        http: failing.client,
        logger: silentLogger(),
        maxBatchSize: 1,
        backoffMs: () => 20,
      });
      outboxes.push(obA);

      obA.enqueue([textEnvelope("before crash")]);
      await sleep(10); // flush() ran synchronously (maxBatchSize:1); let the first failed send happen
      expect(obA.queuedBatchCount).toBe(1);

      const queueFile = outboxQueuePath(homeDir, sessionId);
      expect(existsSync(queueFile)).toBe(true);
      const onDisk = JSON.parse(readFileSync(queueFile, "utf8").trim()) as {
        localId: string;
        content: EncryptedBox;
      };

      // Simulate the crash: stop instance A's retry loop entirely (real process death would
      // just stop scheduling timers — the queue file is already durably on disk from flush()).
      obA.dispose();

      // Instance B: a fresh Outbox against the same homeDir/sessionId, this time with a
      // server that's back up.
      const succeeding = alwaysOkClient();
      const obB = new Outbox({
        sessionId,
        homeDir,
        dek,
        http: succeeding.client,
        logger: silentLogger(),
      });
      outboxes.push(obB);

      // Constructor-time replay: the reloaded batch should start draining without any enqueue().
      expect(obB.queuedBatchCount).toBe(1);
      await sleep(30);

      expect(succeeding.calls).toEqual([{ sessionId, localId: onDisk.localId }]);
      expect(obB.queuedBatchCount).toBe(0);
      expect(existsSync(queueFile)).toBe(false); // fully drained → file removed

      // And the replayed content really does decrypt back to the original envelope.
      const decrypted = open<SessionEnvelope[]>(onDisk.content, dek);
      expect(decrypted?.[0]?.ev).toEqual({ t: "text", md: "before crash" });
    });
  });

  describe("retry until 2xx", () => {
    it("keeps retrying through 5xx, 4xx, and thrown network errors, and eventually succeeds", async () => {
      const dek = getRandomBytes(32);
      const { client, calls } = scriptedHttpClient([
        { ok: false, status: 500 },
        { ok: false, status: 429 },
        { throws: true },
        { ok: false, status: 404 }, // a 4xx — still retried, never treated as permanent
        { ok: true, status: 200 },
      ]);
      const ob = makeOutbox({ dek, http: client, maxBatchSize: 1, backoffMs: () => 5 });

      ob.enqueue([textEnvelope("retry me")]);
      expect(ob.queuedBatchCount).toBe(1); // sealed synchronously

      await sleep(200);

      expect(calls.length).toBe(5);
      expect(ob.queuedBatchCount).toBe(0); // finally acked and dequeued
    });

    it("never gives up on a persistent 4xx — blind retry, no permanent-failure branch", async () => {
      const dek = getRandomBytes(32);
      const { client, calls } = scriptedHttpClient([
        { ok: false, status: 400 },
        { ok: false, status: 400 },
        { ok: false, status: 400 },
        { ok: true, status: 201 },
      ]);
      const ob = makeOutbox({ dek, http: client, maxBatchSize: 1, backoffMs: () => 5 });

      ob.enqueue([textEnvelope("stubborn 4xx")]);
      await sleep(120);

      expect(calls.length).toBe(4);
      expect(ob.queuedBatchCount).toBe(0);
    });
  });

  describe("token refresh on 401 (issue #1: a captured static token used to retry a dead 401 forever)", () => {
    it("recovers once the http client's auth source is refreshed, instead of retrying the stale token forever", async () => {
      const dek = getRandomBytes(32);
      // Simulates a `TokenProvider`: `getAccessToken()` returns whatever's currently
      // cached; `forceRefresh()` (wired below to the http client's `onUnauthorized`)
      // rotates in a fresh one, mirroring `tokenProvider.ts`'s real shape closely enough
      // to exercise `createHttpClient`'s `getAuthToken`/`onUnauthorized` wiring.
      let currentToken = "stale-token";
      let refreshCount = 0;
      const tokenProviderFake = {
        getAccessToken: async () => currentToken,
        forceRefresh: async () => {
          refreshCount += 1;
          currentToken = "fresh-token";
          return currentToken;
        },
      };

      const seenAuthHeaders: (string | undefined)[] = [];
      const fetchImpl = (async (_url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        seenAuthHeaders.push(headers.authorization);
        if (headers.authorization === "Bearer stale-token") {
          return new Response(null, { status: 401 });
        }
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch;

      const http = createHttpClient({
        serverUrl: "http://server.test",
        getAuthToken: () => tokenProviderFake.getAccessToken(),
        onUnauthorized: () => tokenProviderFake.forceRefresh(),
        fetchImpl,
      });

      const ob = makeOutbox({ dek, http, maxBatchSize: 1, backoffMs: () => 5 });
      ob.enqueue([textEnvelope("recovers after refresh")]);

      await sleep(100);

      expect(ob.queuedBatchCount).toBe(0); // eventually acked and dequeued
      expect(refreshCount).toBe(1); // forced exactly once, not once per retry
      expect(seenAuthHeaders).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
    });
  });

  describe("disk queue byte cap (design §11: 10MB cap, oldest evicted first)", () => {
    it("evicts the oldest queued batch(es) once the cap is exceeded, keeping the newest", async () => {
      const dek = getRandomBytes(32);
      // Never acks, so nothing dequeues — isolates the append-time eviction behavior
      // from drain/ack timing.
      const neverAcks = scriptedHttpClient([{ throws: true }]);

      // Probe a single batch's on-disk size so the cap can be sized deterministically
      // relative to real payload size, rather than guessing a byte count.
      const probeSessionId = "sess-cap-probe";
      const probe = new Outbox({
        sessionId: probeSessionId,
        homeDir,
        dek,
        http: neverAcks.client,
        logger: silentLogger(),
        maxBatchSize: 1,
        backoffMs: () => 60_000,
      });
      outboxes.push(probe);
      probe.enqueue([textEnvelope("probe")]);
      expect(probe.queuedBatchCount).toBe(1);
      const probeOnDisk = JSON.parse(
        readFileSync(outboxQueuePath(homeDir, probeSessionId), "utf8").trim(),
      ) as { bytes: number };
      const perBatchBytes: number = probeOnDisk.bytes;
      probe.dispose();

      // Cap sized to hold ~2.5 batches: enqueue 4 same-sized batches and expect only
      // the newest ~2 to survive, oldest evicted first.
      const capSessionId = "sess-cap-evict";
      const maxQueueBytes = Math.floor(perBatchBytes * 2.5);
      const capped = new Outbox({
        sessionId: capSessionId,
        homeDir,
        dek,
        http: neverAcks.client,
        logger: silentLogger(),
        maxBatchSize: 1,
        maxQueueBytes,
        backoffMs: () => 60_000,
      });
      outboxes.push(capped);

      capped.enqueue([textEnvelope("batch-1-oldest")]);
      capped.enqueue([textEnvelope("batch-2")]);
      capped.enqueue([textEnvelope("batch-3")]);
      capped.enqueue([textEnvelope("batch-4-newest")]);

      // Never given more than fits under the cap, and the newest entry is always kept
      // even though only ~2.5 batches fit (appendWithCap keeps at least 1).
      expect(capped.queuedBatchCount).toBeLessThan(4);
      expect(capped.queuedBatchCount).toBeGreaterThanOrEqual(1);

      const onDiskLines = readFileSync(outboxQueuePath(homeDir, capSessionId), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { localId: string; content: EncryptedBox });
      expect(onDiskLines).toHaveLength(capped.queuedBatchCount);

      // The surviving batches must be a suffix of the 4 enqueued (oldest evicted first) —
      // decrypt each to check which original envelope text survived.
      const survivingTexts = onDiskLines.map((entry) => {
        const decrypted = open<SessionEnvelope[]>(entry.content, dek);
        const ev = decrypted?.[0]?.ev;
        if (!ev) throw new Error("expected a decrypted envelope");
        return (ev as { t: "text"; md: string }).md;
      });
      expect(survivingTexts.at(-1)).toBe("batch-4-newest"); // newest is never evicted
      expect(survivingTexts).not.toContain("batch-1-oldest"); // oldest was evicted
    });
  });
});
