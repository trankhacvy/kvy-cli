import { z } from "zod";

/**
 * `preview.*` machine RPCs (docs/features/dev-server-preview.md — "Live
 * dev-server preview via secure tunnel", docs/competitive-notes-omnara.md
 * #6). The Preview tab's data source: enumerate the machine's listening TCP
 * ports, then, given one, open/close a Cloudflare quick tunnel so the
 * running dev server is reachable from anywhere — no manual ngrok/tunnel
 * setup. This is the schema half of the `preview:*` namespace `reserved.ts`
 * set aside; see that file's updated comment for the ephemeral-streaming
 * namespace itself, which stays reserved for a future live-status channel
 * (Phase 2, not MVP — this is a request/response polling MVP).
 *
 * MVP scope, recorded here so a future reader doesn't have to reconstruct it
 * from the daemon handler: **quick tunnels only** (`cloudflared tunnel --url
 * ...`, no named tunnel / custom domain support), and `cloudflared` itself is
 * detected on PATH, never installed by Kvy (it's a Go binary, not an npm
 * package — the pinned-manifest adapter manager in `packages/cli/src/
 * adapters/` doesn't apply).
 *
 * **Non-E2E caveat**: unlike every other RPC body on this wire (sealed under
 * PUBLIC, UNAUTHENTICATED URL — traffic to it is plain HTTP(S) to whoever
 * has the link, not E2E-encrypted. The RPC call itself is E2E; the resulting
 * tunnel is not. Callers must present this distinction to the user before
 * opening one (see `features/preview/`'s consent dialog).
 *
 * **Idempotency**: `preview.ports`/`preview.tunnels` are pure reads (no
 * cache needed, same reasoning as `git.status`/`git.diff` in `rpc.ts`).
 * `preview.open` DOES need `withIdempotencyCache` — it's the one RPC in this
 * family with a real side effect (spawning a `cloudflared` child) — PLUS a
 * port-keyed guard so two concurrent opens for the same port collapse into
 * one spawn (mirrors `rpc.ts`'s `adopt.take`/`withProviderSessionGuard`
 * precedent). `preview.close` is a natural no-op on retry (closing an
 * already-closed tunnel is a no-op), so — like `fs.mkdir` — it needs no
 * cache, though it still carries `idempotencyKey` for uniformity with the
 * rest of this RPC family.
 */

export const PreviewPortsParamsSchema = z.object({
  idempotencyKey: z.string(),
});
export type PreviewPortsParams = z.infer<typeof PreviewPortsParamsSchema>;

export const PreviewPortInfoSchema = z.object({
  port: z.number().int(),
  /** The bound address as `lsof` reports it (e.g. `127.0.0.1`, `*`, `::1`) — not normalized, so the caller can distinguish a loopback-only bind from a wildcard one. */
  address: z.string(),
  pid: z.number().int().optional(),
  processName: z.string().optional(),
});
export type PreviewPortInfo = z.infer<typeof PreviewPortInfoSchema>;

export const PreviewPortsResultSchema = z.object({
  cloudflared: z.object({
    installed: z.boolean(),
    version: z.string().optional(),
  }),
  /** Every listening TCP port currently visible to `lsof` on this machine — machine-wide, not scoped to any one workspace/session (see `portScan.ts`'s own doc comment for why). */
  ports: z.array(PreviewPortInfoSchema),
});
export type PreviewPortsResult = z.infer<typeof PreviewPortsResultSchema>;

export const PreviewTunnelsParamsSchema = z.object({
  idempotencyKey: z.string(),
});
export type PreviewTunnelsParams = z.infer<typeof PreviewTunnelsParamsSchema>;

// Multi-value `z.literal([...])`, NOT `z.enum` (rpc.ts's `SpawnResult.action`
// comment at rpc.ts:70-81 explains why: `schemaShape.ts`'s `describeShape`
// treats a schema's `kind` as part of its frozen shape, and reports
// `z.literal(...)` and `z.enum([...])` as two *different* kinds — switching
// later would be a breaking "kind change" under the frozen fixture even
// though the value set only grew).
export const TunnelStatusSchema = z.literal(["starting", "active"]);
export type TunnelStatus = z.infer<typeof TunnelStatusSchema>;

export const TunnelInfoSchema = z.object({
  tunnelId: z.string(),
  port: z.number().int(),
  url: z.string(),
  status: TunnelStatusSchema,
  startedAt: z.number(),
});
export type TunnelInfo = z.infer<typeof TunnelInfoSchema>;

export const PreviewTunnelsResultSchema = z.object({
  tunnels: z.array(TunnelInfoSchema),
});
export type PreviewTunnelsResult = z.infer<typeof PreviewTunnelsResultSchema>;

export const PreviewOpenParamsSchema = z.object({
  idempotencyKey: z.string(),
  port: z.number().int(),
});
export type PreviewOpenParams = z.infer<typeof PreviewOpenParamsSchema>;

export const PreviewOpenResultSchema = z.object({
  tunnelId: z.string(),
  url: z.string(),
  port: z.number().int(),
});
export type PreviewOpenResult = z.infer<typeof PreviewOpenResultSchema>;

export const PreviewCloseParamsSchema = z.object({
  idempotencyKey: z.string(),
  tunnelId: z.string(),
});
export type PreviewCloseParams = z.infer<typeof PreviewCloseParamsSchema>;

export const PreviewCloseResultSchema = z.object({
  ok: z.boolean(),
});
export type PreviewCloseResult = z.infer<typeof PreviewCloseResultSchema>;
