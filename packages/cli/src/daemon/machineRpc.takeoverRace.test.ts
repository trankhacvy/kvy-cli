import { open, seal } from "@falcon/crypto";
import type { AdoptTakeParams, AdoptTakeResult, EncryptedBox } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import { type MachineRpcDeps, registerMachineRpcHandlers } from "./machineRpc.js";

// Double-takeover race (plan.md §16 "4.4 Hardening & release gate": "double-takeover
// race — two clients calling `adopt.take` concurrently"): verifies the idempotency-key
// replay / atomic-resolve guarantees this module already documents for `spawn` and
// `perm.answer` (`claude/permissionHandler.ts`'s atomic first-wins `resolve()`) also
// hold for `adopt.take`, under genuine concurrency — not just sequential retry-after-
// the-fact, which `machineRpc.test.ts`'s "replays the cached result for a retried
// idempotencyKey" tests already cover.
//
// "Two clients" concretely means two different devices, each minting its own
// `idempotencyKey`, both hitting take-over on the same unmanaged session at once — the
// idempotency-key cache alone (keyed on the *request*) never sees those as the same
// call, so `withProviderSessionGuard` (keyed on the *target*, `providerSessionId`) is
// what has to hold here (design FR-9.4: "never two live continuations of the same
// history").
//
// Uses the same `FakeSocket` harness as `machineRpc.test.ts` (no real transport needed —
// the race lives entirely in this module's synchronous cache-check-then-set logic) plus
// a manually-resolvable "deferred" `adoptTake` so both concurrent calls are provably
// still in flight before either is allowed to settle.

class FakeSocket {
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  emitted: { event: string; payload: unknown }[] = [];
  connected = false;

  on(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(
      event,
      list.filter((h) => h !== handler),
    );
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  trigger(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

const DEK = new Uint8Array(32).fill(3);

function adoptTakeParams(overrides: Partial<AdoptTakeParams> = {}): AdoptTakeParams {
  return {
    idempotencyKey: "idem_default",
    providerSessionId: "prov_default",
    mode: "takeover",
    ...overrides,
  };
}

function register(
  socket: FakeSocket,
  overrides: Partial<MachineRpcDeps> = {},
): ReturnType<typeof registerMachineRpcHandlers> {
  return registerMachineRpcHandlers({
    machineId: "mach_1",
    dek: DEK,
    socket: socket as unknown as import("socket.io-client").Socket,
    spawnSession: vi.fn(),
    resumeSession: vi.fn(),
    adoptTake: vi.fn(),
    adoptMirror: vi.fn(),
    ...overrides,
  });
}

function callAndAwaitAck(
  socket: FakeSocket,
  method: string,
  params: unknown,
): Promise<EncryptedBox> {
  return new Promise((resolve) => {
    socket.trigger("rpc-request", { method, params }, (response: EncryptedBox) =>
      resolve(response),
    );
  });
}

/** A promise plus its resolve/reject, so a test can prove two calls are simultaneously in flight before either is allowed to settle. */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("adopt.take double-takeover race", () => {
  it("collapses two concurrent calls with the SAME idempotencyKey into a single takeover attempt", async () => {
    const socket = new FakeSocket();
    const deferred = createDeferred<AdoptTakeResult>();
    const adoptTake = vi.fn(() => deferred.promise);
    register(socket, { adoptTake });

    const params = adoptTakeParams({ idempotencyKey: "idem_retry", providerSessionId: "prov_1" });

    // Both calls fire synchronously (a `FakeSocket.trigger` runs its handlers
    // synchronously) before `adoptTake` has had any chance to resolve — the realistic
    // shape of a duplicate submission or client-side retry racing itself.
    const first = callAndAwaitAck(socket, "adopt.take", seal(params, DEK));
    const second = callAndAwaitAck(socket, "adopt.take", seal(params, DEK));

    expect(adoptTake).toHaveBeenCalledTimes(1);

    deferred.resolve({ sessionId: "sess_winner" });
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(adoptTake).toHaveBeenCalledTimes(1);
    expect(open(firstResponse, DEK)).toEqual({ sessionId: "sess_winner" });
    expect(open(secondResponse, DEK)).toEqual({ sessionId: "sess_winner" });
  });

  it("collapses two concurrent calls with DIFFERENT idempotencyKeys for the same providerSessionId — the real two-devices shape", async () => {
    const socket = new FakeSocket();
    const deferred = createDeferred<AdoptTakeResult>();
    const adoptTake = vi.fn(() => deferred.promise);
    register(socket, { adoptTake });

    // Two different devices adopting the same unmanaged session each mint their own key.
    const fromDeviceA = adoptTakeParams({
      idempotencyKey: "idem_device_a",
      providerSessionId: "prov_shared",
    });
    const fromDeviceB = adoptTakeParams({
      idempotencyKey: "idem_device_b",
      providerSessionId: "prov_shared",
    });

    const responseA = callAndAwaitAck(socket, "adopt.take", seal(fromDeviceA, DEK));
    const responseB = callAndAwaitAck(socket, "adopt.take", seal(fromDeviceB, DEK));

    // Only one real kill+spawn attempt is allowed to happen — the second device joins
    // the first's in-flight attempt instead of racing its own independent takeover.
    expect(adoptTake).toHaveBeenCalledTimes(1);
    expect(adoptTake).toHaveBeenCalledWith(fromDeviceA);

    deferred.resolve({ sessionId: "sess_shared", warning: "interrupted mid-turn" });
    const [resultA, resultB] = await Promise.all([responseA, responseB]);

    // Both devices see the exact same outcome of the one takeover that actually ran,
    // including the mid-turn warning — never a duplicated or divergent result.
    const expected = { sessionId: "sess_shared", warning: "interrupted mid-turn" };
    expect(open(resultA, DEK)).toEqual(expected);
    expect(open(resultB, DEK)).toEqual(expected);
    expect(adoptTake).toHaveBeenCalledTimes(1);
  });

  it("does NOT collapse concurrent calls for DIFFERENT providerSessionIds — unrelated takeovers still run independently", async () => {
    const socket = new FakeSocket();
    const adoptTake = vi.fn(
      async (params: AdoptTakeParams): Promise<AdoptTakeResult> => ({
        sessionId: `sess_for_${params.providerSessionId}`,
      }),
    );
    register(socket, { adoptTake });

    const responseA = callAndAwaitAck(
      socket,
      "adopt.take",
      seal(adoptTakeParams({ idempotencyKey: "idem_a", providerSessionId: "prov_a" }), DEK),
    );
    const responseB = callAndAwaitAck(
      socket,
      "adopt.take",
      seal(adoptTakeParams({ idempotencyKey: "idem_b", providerSessionId: "prov_b" }), DEK),
    );

    const [resultA, resultB] = await Promise.all([responseA, responseB]);

    expect(adoptTake).toHaveBeenCalledTimes(2);
    expect(open(resultA, DEK)).toEqual({ sessionId: "sess_for_prov_a" });
    expect(open(resultB, DEK)).toEqual({ sessionId: "sess_for_prov_b" });
  });

  it("does not cache a rejected takeover, and a later retry for the same providerSessionId runs fresh", async () => {
    const socket = new FakeSocket();
    const deferred = createDeferred<AdoptTakeResult>();
    const adoptTake = vi
      .fn()
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValueOnce({ sessionId: "sess_recovered" } satisfies AdoptTakeResult);
    register(socket, { adoptTake });

    const paramsA = adoptTakeParams({ idempotencyKey: "idem_a", providerSessionId: "prov_fail" });
    const paramsB = adoptTakeParams({ idempotencyKey: "idem_b", providerSessionId: "prov_fail" });

    const responseA = callAndAwaitAck(socket, "adopt.take", seal(paramsA, DEK));
    const responseB = callAndAwaitAck(socket, "adopt.take", seal(paramsB, DEK));
    expect(adoptTake).toHaveBeenCalledTimes(1);

    deferred.reject(new Error("no owning process found"));
    const [resultA, resultB] = await Promise.all([responseA, responseB]);

    // Both concurrent callers see the same failure — neither silently hangs nor gets a
    // divergent answer.
    expect(open(resultA, DEK)).toEqual({ ok: false, error: "no owning process found" });
    expect(open(resultB, DEK)).toEqual({ ok: false, error: "no owning process found" });

    // The failed attempt must not wedge the providerSessionId forever: a genuinely new
    // takeover attempt afterwards (new idempotencyKey, arrives once the failure has
    // already settled) has to actually run, not replay the stale rejection.
    const retryParams = adoptTakeParams({
      idempotencyKey: "idem_retry",
      providerSessionId: "prov_fail",
    });
    const retryResponse = await callAndAwaitAck(socket, "adopt.take", seal(retryParams, DEK));

    expect(adoptTake).toHaveBeenCalledTimes(2);
    expect(open(retryResponse, DEK)).toEqual({ sessionId: "sess_recovered" });
  });
});
