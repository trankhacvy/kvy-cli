import {
  MachineRowSchema,
  SessionRowSchema,
  UnmanagedSessionRowSchema,
  WorkspaceRowSchema,
} from "@falcon/wire";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { accounts, machines, sessions, unmanagedSessions, workspaces } from "../../db/schema.js";
import type { Database } from "../../db/types.js";
import type { EventRouterPort } from "../events/eventRouter.js";
import { computeMachinesNeedReauth } from "../machineReauth.js";
import type { PushDispatcherPort } from "../push/types.js";
import { reconcileStaleSessions } from "../staleSessions.js";
import { toMachineRow, toSessionRow, toUnmanagedSessionRow, toWorkspaceRow } from "./mappers.js";

const SyncQuerySchema = z.object({ since: z.coerce.number().int().nonnegative() });

const SyncResponseSchema = z.object({
  headerSeq: z.number(),
  sessions: z.array(SessionRowSchema),
  machines: z.array(MachineRowSchema),
  unmanagedSessions: z.array(UnmanagedSessionRowSchema),
  workspaces: z.array(WorkspaceRowSchema),
});

/**
 * `GET /v1/sync?since=<headerSeq>` (design §4.3/§6.2): the resync path a
 * client takes on a header-stream gap (`seq !== lastSeq + 1`) or on cold
 * start. There's no persisted change log for structural entities, so this
 * is a full account **snapshot** (sessions, machines, unmanaged sessions) —
 * not an incremental delta from `since` — matching the design doc's own
 * description ("account snapshot headers"). `since` is accepted and
 * validated per the wire contract; using it to skip work is a future
 * optimization (would need a changelog table), not a correctness
 * requirement — the client always gets the true current state either way.
 */
export function buildSyncRoutes(
  db: Database,
  eventRouter: EventRouterPort,
  pushDispatcher: PushDispatcherPort,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      "/v1/sync",
      {
        preHandler: app.authenticate,
        schema: { querystring: SyncQuerySchema, response: { 200: SyncResponseSchema } },
      },
      async (req, reply) => {
        const accountId = req.accountId;
        const [account, sessionRows, machineRows, unmanagedRows, workspaceRows] = await Promise.all(
          [
            db.query.accounts.findFirst({ where: eq(accounts.id, accountId) }),
            db.query.sessions.findMany({ where: eq(sessions.accountId, accountId) }),
            db.query.machines.findMany({ where: eq(machines.accountId, accountId) }),
            db.query.unmanagedSessions.findMany({
              where: eq(unmanagedSessions.accountId, accountId),
            }),
            db.query.workspaces.findMany({ where: eq(workspaces.accountId, accountId) }),
          ],
        );

        if (!account) {
          // A valid bearer token decoded to an accountId with no accounts
          // row — the account was deleted out from under a live token.
          // Fail loudly rather than returning a bogus empty snapshot.
          throw new Error(`GET /v1/sync: authenticated accountId ${accountId} has no account row`);
        }

        // AH8 "machine-status-reauth": the bootstrap/no-live-event path's
        // source for `MachineRow.needsReauth` — one batched query for every
        // machine in this snapshot rather than one query per row.
        const needsReauthByMachine = await computeMachinesNeedReauth(
          db,
          accountId,
          machineRows.map((m) => m.id),
        );

        // known-issues.md #8: this snapshot already fetched every machine
        // for the account above, so reuse it for the reconciliation's
        // staleness check instead of a second query — see `staleSessions.ts`.
        const machineLastSeenById = new Map(machineRows.map((m) => [m.id, m.lastSeenAt]));
        const reconciledSessions = await reconcileStaleSessions(
          db,
          eventRouter,
          pushDispatcher,
          reply,
          accountId,
          sessionRows,
          machineLastSeenById,
        );

        return {
          headerSeq: account.headerSeq,
          sessions: reconciledSessions.map(toSessionRow),
          machines: machineRows.map((m) => toMachineRow(m, needsReauthByMachine.get(m.id))),
          unmanagedSessions: unmanagedRows.map(toUnmanagedSessionRow),
          workspaces: workspaceRows.map(toWorkspaceRow),
        };
      },
    );
  };
}
