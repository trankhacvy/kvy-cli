import { z } from "zod";
import { EncryptedBoxSchema, VersionedSchema } from "./box";
import { LifecycleKindSchema } from "./push";
import {
  MachineRowSchema,
  SessionRowSchema,
  SessionStatusSchema,
  UnmanagedSessionRowSchema,
} from "./rows";

/**
 * Persistent, seq-ordered server -> client updates (design §4.3).
 *
 * ⚠ DELTA D1/D2 from Happy: writes happen over idempotent HTTP, not WS —
 * `Update` is a read-only broadcast of what already landed. `seq` is the
 * *account* `headerSeq` and is only present on structural updates;
 * `message-new` carries its own per-session `msgSeq` instead (gap-detection
 * for the high-rate transcript stream never contends with the low-rate
 * header stream).
 */
export const UpdateBodySchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("session-new"),
    session: SessionRowSchema,
  }),
  z.object({
    t: z.literal("session-update"),
    id: z.string(),
    metadata: VersionedSchema(EncryptedBoxSchema).optional(),
    agentState: VersionedSchema(EncryptedBoxSchema).optional(),
    status: SessionStatusSchema.optional(),
  }),
  z.object({
    t: z.literal("session-delete"),
    id: z.string(),
  }),
  z.object({
    t: z.literal("message-new"),
    sessionId: z.string(),
    msgSeq: z.number(), // per-session order; NOT the account headerSeq
    localId: z.string().optional(),
    content: EncryptedBoxSchema,
  }),
  z.object({
    t: z.literal("machine-new"),
    machine: MachineRowSchema,
  }),
  z.object({
    t: z.literal("machine-update"),
    machine: MachineRowSchema,
  }),
  z.object({
    t: z.literal("unmanaged-new"),
    item: UnmanagedSessionRowSchema,
  }),
  z.object({
    t: z.literal("unmanaged-update"),
    item: UnmanagedSessionRowSchema,
  }),
  z.object({
    t: z.literal("account-update"),
    settings: EncryptedBoxSchema,
  }),
]);
export type UpdateBody = z.infer<typeof UpdateBodySchema>;

export const UpdateSchema = z.object({
  seq: z.number().optional(), // account headerSeq; absent on message-new
  ts: z.number(),
  body: UpdateBodySchema,
});
export type Update = z.infer<typeof UpdateSchema>;

/**
 * Volatile server -> client signals: never persisted, never gap-checked,
 * safe to coalesce/drop under backpressure (design §4.3).
 */
export const EphemeralSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("activity"),
    sessionId: z.string(),
    working: z.boolean(),
  }),
  z.object({
    t: z.literal("machine-presence"),
    machineId: z.string(),
    online: z.boolean(),
  }),
  z.object({
    t: z.literal("attention"),
    sessionId: z.string(),
    kind: LifecycleKindSchema,
  }),
]);
export type Ephemeral = z.infer<typeof EphemeralSchema>;
