import { z } from "zod";
import { EncryptedBoxSchema, VersionedSchema } from "./box";

/**
 * Wire-visible row shapes for `session-new`/`machine-new`/`unmanaged-new`
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
  // The account key epoch `dek` was wrapped under (mirrors `sessions.key_epoch` in the DB
  // schema). Optional/additive so an old client that doesn't know this field yet just
  // Lets the client tell "encrypted under a key I no longer have, after a reset" apart
  // from a genuine decrypt failure, instead of just failing to decrypt and guessing.
  keyEpoch: z.number().optional(),
  msgSeq: z.number(),
  // not part of `metadata` — because the server's push dispatcher reads it
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
  // Server-inferred from "most recent `cli-daemon`
  // `device_sessions` row for this machine is revoked" — the
  // bootstrap/no-live-event path's source for "Needs
  // re-authentication" vs. plain "Offline". Additive/optional so an old client
  needsReauth: z.boolean().optional(),
});
export type MachineRow = z.infer<typeof MachineRowSchema>;

export const WorkspaceRowSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  path: z.string(),
  metadata: VersionedSchema(EncryptedBoxSchema), // enc: baseBranch, remote
  dek: z.string(),
});
export type WorkspaceRow = z.infer<typeof WorkspaceRowSchema>;

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
