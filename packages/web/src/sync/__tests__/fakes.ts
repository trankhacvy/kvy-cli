/**
 * In-memory doubles for apiSocket's injectable dependencies — no real
 * network connection or `document`, so the connect/reconnect/backoff state
 * machine and app-state reporting can be verified under plain Vitest
 * (mirrors crypto/__tests__/loopback.ts).
 */
import type { ApiSocketAuth, SocketFactory, SocketLike, VisibilitySource } from "../apiSocket.js";

export interface FakeSocket extends SocketLike {
  /** Simulate the server side emitting an event to this socket. */
  serverEmit(event: string, payload?: unknown): void;
  /** Every payload the client emitted via `.emit()`, in order. */
  emitted: Array<{ event: string; args: unknown[] }>;
  /** Every auth snapshot `getAuth()` produced, one per `.connect()` call. */
  authSnapshots: ApiSocketAuth[];
}

export function createFakeSocketFactory(): {
  factory: SocketFactory;
  /** All sockets ever created by this factory, in creation order. */
  sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];

  const factory: SocketFactory = (getAuth) => {
    const handlers = new Map<string, Set<(...args: never[]) => void>>();
    let connected = false;
    const emitted: Array<{ event: string; args: unknown[] }> = [];
    const authSnapshots: ApiSocketAuth[] = [];

    const socket: FakeSocket = {
      get connected() {
        return connected;
      },
      connect() {
        connected = true;
        authSnapshots.push(getAuth());
        for (const h of handlers.get("connect") ?? []) (h as () => void)();
      },
      disconnect() {
        connected = false;
        for (const h of handlers.get("disconnect") ?? []) (h as () => void)();
      },
      on(event, handler) {
        let set = handlers.get(event);
        if (!set) {
          set = new Set();
          handlers.set(event, set);
        }
        set.add(handler);
      },
      off(event, handler) {
        if (!handler) {
          handlers.delete(event);
          return;
        }
        handlers.get(event)?.delete(handler);
      },
      emit(event, ...args) {
        emitted.push({ event, args });
      },
      serverEmit(event, payload) {
        for (const h of handlers.get(event) ?? []) (h as (p: unknown) => void)(payload);
      },
      emitted,
      authSnapshots,
    };
    sockets.push(socket);
    return socket;
  };

  return { factory, sockets };
}

export function createFakeVisibilitySource(initial: "active" | "background" = "active"): {
  source: VisibilitySource;
  trigger(state: "active" | "background"): void;
} {
  let state = initial;
  const subscribers = new Set<(state: "active" | "background") => void>();
  return {
    source: {
      currentState: () => state,
      subscribe(handler) {
        subscribers.add(handler);
        return () => subscribers.delete(handler);
      },
    },
    trigger(next) {
      state = next;
      for (const h of subscribers) h(next);
    },
  };
}
