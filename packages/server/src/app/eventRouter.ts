import { EventEmitter } from "node:events";
import type { Ephemeral, Update } from "@falcon/wire";

/**
 * Who should receive a fanned-out update (design §6.3's recipient filters,
 * scoped down to what the write routes in `app/routes/` actually need —
 * `session-scoped`/`machine-scoped` room membership itself is task 1.1's
 * Socket.IO work).
 */
export type RecipientFilter =
  | { type: "all-user"; accountId: string }
  | { type: "session-interested"; accountId: string; sessionId: string }
  | { type: "machine-only"; accountId: string; machineId: string };

export interface UpdateEvent {
  recipientFilter: RecipientFilter;
  update: Update;
}

export interface EphemeralEvent {
  recipientFilter: RecipientFilter;
  ephemeral: Ephemeral;
}

/**
 * The fan-out seam between the HTTP write path (this task) and the Socket.IO
 * read path (task 1.1, §4.1/§4.2 — not yet landed). Every write route calls
 * `emitUpdate`/`emitEphemeral` post-commit (never from inside a transaction —
 * design §6.1's "post-commit hook emits WS updates" rule) instead of talking
 * to Socket.IO rooms directly, so route code never has to change once 1.1
 * lands: `packages/server/src/app/socket.ts` will subscribe an
 * `io.to(room).emit(...)` listener via `onUpdate`/`onEphemeral` and this
 * module's job is done.
 */
export interface EventRouter {
  emitUpdate(event: UpdateEvent): void;
  emitEphemeral(event: EphemeralEvent): void;
}

type UpdateListener = (event: UpdateEvent) => void;
type EphemeralListener = (event: EphemeralEvent) => void;

/**
 * In-process pub/sub. Until Socket.IO lands, this IS the fan-out: nothing
 * outside this process observes these events except test/future subscribers
 * via `onUpdate`/`onEphemeral`. That's intentional — the write routes'
 * observable contract (one row written ⇒ one fan-out event emitted) doesn't
 * depend on there being a live transport, only on this router being called
 * exactly once per logical change.
 */
/**
 * Exported as a value (not just a type) so tests can instantiate their own
 * isolated router — asserting "exactly one fan-out event" is only
 * meaningful against a router no other concurrently-running test can also
 * emit into, which the shared `eventRouter` singleton below can't guarantee.
 */
export class InMemoryEventRouter implements EventRouter {
  private readonly emitter = new EventEmitter();

  emitUpdate(event: UpdateEvent): void {
    this.emitter.emit("update", event);
  }

  emitEphemeral(event: EphemeralEvent): void {
    this.emitter.emit("ephemeral", event);
  }

  /** Returns an unsubscribe function. */
  onUpdate(listener: UpdateListener): () => void {
    this.emitter.on("update", listener);
    return () => this.emitter.off("update", listener);
  }

  /** Returns an unsubscribe function. */
  onEphemeral(listener: EphemeralListener): () => void {
    this.emitter.on("ephemeral", listener);
    return () => this.emitter.off("ephemeral", listener);
  }
}

/**
 * Process-wide singleton (mirrors Happy's `eventRouter` module — see
 * plan.md §4.1). Route factories accept an `EventRouter` as a constructor
 * argument (defaulting to this instance) so tests can inject their own and
 * assert on fan-out without a real socket connection.
 */
export const eventRouter = new InMemoryEventRouter();
