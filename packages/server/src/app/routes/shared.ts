import { z } from "zod";

/** `:id` route param shared by every `/v1/sessions/:id/...` route. */
export const SessionIdParamsSchema = z.object({ id: z.string().min(1) });

/**
 * Empty-body 404 (resource missing or not owned by the caller — the two are
 * deliberately indistinguishable to avoid leaking existence of other
 * accounts' rows). Declared explicitly (rather than left off `schema.response`)
 * so fastify-type-provider-zod's typed `reply.code(...)` accepts 404 as a
 * valid status for these routes.
 */
export const NotFoundSchema = z.object({});

/**
 * `GET /sessions?cursor`). Keyset (not offset) pagination so a page is stable
 * under concurrent inserts/updates — an offset cursor would skip or repeat
 * rows as `updatedAt` churns.
 */
export function encodeSessionCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeSessionCursor(cursor: string): { updatedAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!iso || !id || Number.isNaN(Date.parse(iso))) {
    throw new Error("invalid cursor");
  }
  return { updatedAt: new Date(iso), id };
}
