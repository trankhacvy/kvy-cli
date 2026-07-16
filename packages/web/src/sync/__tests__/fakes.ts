import type { Update } from "@falcon/wire";
import type { SyncSocketSource } from "../engine.js";

/** In-memory `SyncSocketSource` double — mirrors what a real `apiSocket`'s
 * `on('update'|'reconnect', ...)` would deliver, without any Socket.IO
 * connection (see `apiSocket.ts`'s own `fakes.ts` for the same pattern one
 * level down the stack). */
export function createFakeSyncSocket(): {
  source: SyncSocketSource;
  emitUpdate: (update: Update) => void;
  emitReconnect: () => void;
} {
  const updateHandlers = new Set<(update: Update) => void>();
  const reconnectHandlers = new Set<() => void>();

  function on(event: "update", handler: (update: Update) => void): () => void;
  function on(event: "reconnect", handler: () => void): () => void;
  function on(
    event: "update" | "reconnect",
    handler: ((update: Update) => void) | (() => void),
  ): () => void {
    if (event === "update") {
      const h = handler as (update: Update) => void;
      updateHandlers.add(h);
      return () => updateHandlers.delete(h);
    }
    const h = handler as () => void;
    reconnectHandlers.add(h);
    return () => reconnectHandlers.delete(h);
  }

  return {
    source: { on },
    emitUpdate: (update) => {
      for (const h of updateHandlers) h(update);
    },
    emitReconnect: () => {
      for (const h of reconnectHandlers) h();
    },
  };
}
