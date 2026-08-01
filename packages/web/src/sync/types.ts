import type {
  EncryptedBox,
  MachineRow,
  SessionRow,
  UnmanagedSessionRow,
  WorkspaceRow,
} from "@kvy/wire";

/**
 * One row from `GET /v1/sessions/:id/messages` (mirrors `MessageItemSchema`
 * in `packages/server/src/app/routes/messages.ts` field-for-field). Not
 * exported from `@kvy/wire` because it's an HTTP response shape, not a
 * wire envelope — `content` is still the untouched `EncryptedBox` the server
 * sent; decryption is a later boundary (crypto-bridge worker, design §5.3),
 * out of scope for the sync engine itself.
 */
export interface MessageItem {
  seq: number;
  localId: string | null;
  content: EncryptedBox;
  createdAt: number;
}

/** One page of `GET /v1/sessions/:id/messages`, newest message first — the
 * route orders `desc(sessionMessages.seq)`. */
export interface MessagesPage {
  messages: MessageItem[];
  nextBefore: number | null;
}

/**
 * The shape TanStack Query's `useInfiniteQuery` stores at `messagesQueryKey`
 * (spelled out locally, rather than importing `InfiniteData`, to keep this
 * module cheap to unit-test against a bare `QueryClient` with hand-built
 * fixtures). `pages[0]` is always the most recent page — the one the
 * message fast-path splices new `message-new` events into.
 */
export interface MessagesQueryData {
  pages: MessagesPage[];
  pageParams: Array<number | undefined>;
}

/** Mirrors `SyncResponseSchema` — the `GET /v1/sync` response
 * (`packages/server/src/app/routes/sync.ts`). */
export interface SyncSnapshot {
  headerSeq: number;
  /** The account's current key epoch — compare against a `SessionRow.keyEpoch` to tell
   *  whether that session was encrypted under a key thrown away by a reset-keys rotation. */
  accountKeyEpoch: number;
  sessions: SessionRow[];
  machines: MachineRow[];
  unmanagedSessions: UnmanagedSessionRow[];
  workspaces: WorkspaceRow[];
}
