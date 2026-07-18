import { z } from "zod";
import { EncryptedBoxSchema, VersionedSchema } from "./box";

/**
 * Wire-visible row shapes for `session-new`/`machine-new`/`unmanaged-new`
 * updates (design §4.3, mirroring the Drizzle tables in §6.1). These are
 * the client-facing projections of the DB rows — every content field stays
 * an opaque `EncryptedBox`, the server never sends plaintext.
 */

export const SessionStatusSchema = z.enum(["active", "archived", "failed", "compacted", "ended"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionRowSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  workspaceId: z.string().nullable(),
  machineId: z.string().nullable(),
  tag: z.string(),
  provider: z.string(),
  executionTarget: z.string(),
  status: SessionStatusSchema,
  metadata: VersionedSchema(EncryptedBoxSchema),
  agentState: VersionedSchema(EncryptedBoxSchema).nullable(),
  dek: z.string(), // opaque sealed-box wrap; server can route it but not open it
  msgSeq: z.number(),
  // Per-session "mute" quiet control (PRD FR-8.3, plan.md §10). Plaintext —
  // not part of `metadata` — because the server's push dispatcher reads it
  // directly (design §5.3: it holds no keys to decrypt `metadata`).
  notificationsMuted: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SessionRow = z.infer<typeof SessionRowSchema>;

export const MachineRowSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  metadata: VersionedSchema(EncryptedBoxSchema),
  daemonState: VersionedSchema(EncryptedBoxSchema).nullable(),
  dek: z.string(),
  lastSeenAt: z.number().nullable(),
});
export type MachineRow = z.infer<typeof MachineRowSchema>;

export const UnmanagedSessionRowSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  machineId: z.string(),
  workspaceId: z.string(),
  providerRef: z.string(),
  summary: EncryptedBoxSchema, // enc: title, lastActivity, running?
  dek: z.string(),
  updatedAt: z.number(),
});
export type UnmanagedSessionRow = z.infer<typeof UnmanagedSessionRowSchema>;
