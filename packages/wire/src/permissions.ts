import { z } from 'zod';

/**
 * The four Claude-Code-style permission modes a session can run under.
 * `setMode` RPC and `mode-switch`/`perm-request` events all reuse this.
 */
export const PermissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * How a pending permission request was resolved. Carried by the
 * `perm-resolve` session event and the `perm.answer` session RPC (design
 * §4.2, §7.6).
 */
export const PermDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('allow'),
    scope: z.enum(['once', 'session']),
    updatedInput: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('deny'),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal('mode'),
    mode: PermissionModeSchema,
  }),
]);
export type PermDecision = z.infer<typeof PermDecisionSchema>;
