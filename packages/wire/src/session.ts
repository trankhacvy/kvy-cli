import { createId } from "@paralleldrive/cuid2";
import { z } from "zod";
import { PermDecisionSchema, PermissionModeSchema } from "./permissions";

export const SessionRoleSchema = z.enum(["user", "agent"]);
export type SessionRole = z.infer<typeof SessionRoleSchema>;

/**
 * The provider-agnostic, flat session event stream (design §4.2). Adapters
 * (Claude Code, Codex) map their native transcript format onto this shape —
 * provider-native ids (`toolu_*`, Codex item ids) never cross the wire, only
 * adapter-minted `call`/`reqId` strings.
 */
export const SessionEventSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("text"),
    md: z.string(),
    thinking: z.boolean().optional(),
  }),
  z.object({
    t: z.literal("service"),
    text: z.string(),
  }),
  z.object({
    t: z.literal("tool-start"),
    call: z.string(),
    name: z.string(),
    title: z.string().optional(),
    args: z.unknown(),
    risk: z.enum(["read", "write", "exec", "network"]).optional(),
  }),
  z.object({
    t: z.literal("tool-end"),
    call: z.string(),
    ok: z.boolean(),
    output: z.unknown().optional(),
  }),
  z.object({
    t: z.literal("file"),
    ref: z.string(),
    name: z.string(),
    size: z.number(),
    image: z
      .object({
        w: z.number(),
        h: z.number(),
        thumbhash: z.string(),
      })
      .optional(),
  }),
  z.object({
    t: z.literal("turn-start"),
  }),
  z.object({
    t: z.literal("turn-end"),
    status: z.enum(["completed", "failed", "cancelled"]),
  }),
  z.object({
    t: z.literal("perm-request"),
    reqId: z.string(),
    call: z.string().optional(),
    name: z.string(),
    args: z.unknown(),
    modes: z.array(PermissionModeSchema),
  }),
  z.object({
    t: z.literal("perm-resolve"),
    reqId: z.string(),
    decision: PermDecisionSchema,
  }),
  z.object({
    t: z.literal("mode-switch"),
    control: z.enum(["local", "remote"]),
    by: z.enum(["terminal", "client"]),
  }),
  z.object({
    t: z.literal("sub-start"),
  }),
  z.object({
    t: z.literal("sub-stop"),
  }),
  z.object({
    t: z.literal("usage"),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number().optional(),
  }),
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/**
 * The envelope every session event is wrapped in before it's batched,
 * encrypted, and POSTed as a `message-new` (design §4.2/§4.3).
 */
export const SessionEnvelopeSchema = z.object({
  id: z.string(), // cuid2, minted by the adapter
  time: z.number(), // epoch ms
  role: SessionRoleSchema,
  turn: z.string().optional(), // cuid2; agent events without a turn are dropped by renderers
  subagent: z.string().optional(), // cuid2; presence => sidechain/subagent scope
  ev: SessionEventSchema,
});
export type SessionEnvelope = z.infer<typeof SessionEnvelopeSchema>;

export interface CreateEnvelopeOptions {
  id?: string;
  time?: number;
  turn?: string;
  subagent?: string;
}

/**
 * Mints a validated envelope, cuid2-generating `id` when the caller doesn't
 * supply one. Always goes through `SessionEnvelopeSchema.parse` so a
 * malformed event throws at creation time, not at the reducer downstream.
 */
export function createEnvelope(
  role: SessionRole,
  ev: SessionEvent,
  opts: CreateEnvelopeOptions = {},
): SessionEnvelope {
  return SessionEnvelopeSchema.parse({
    id: opts.id ?? createId(),
    time: opts.time ?? Date.now(),
    role,
    ...(opts.turn !== undefined ? { turn: opts.turn } : {}),
    ...(opts.subagent !== undefined ? { subagent: opts.subagent } : {}),
    ev,
  });
}
