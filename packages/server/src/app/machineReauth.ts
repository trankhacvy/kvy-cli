import { and, desc, eq, inArray } from "drizzle-orm";
import { deviceSessions } from "../db/schema.js";
import type { Database } from "../db/types.js";

/**
 * AH8 "machine-status-reauth" (docs/auth-ux-hardening-plan.md item 8): the
 * minimum-viable server-inferred signal for "this machine needs
 * `falcon auth login` again" — no CLI change, no schema change. A daemon
 * whose refresh token was revoked (a rotate, "log out other devices", or a
 * password reset's blanket revoke) can't tell the server anything over its
 * now-dead socket, so the server infers it from what it already knows: the
 * most recent `cli-daemon` `device_sessions` row for this machine is itself
 * revoked.
 *
 * `device_sessions.machineId` is populated by `routes/machines.ts`'s
 * `POST /v1/machines` handler backfilling it onto the *calling* device
 * session the first time a `cli-daemon`-authenticated request registers or
 * updates that machine (see that file's own comment) — `issueSession`'s
 * pairing/login call sites (`app/api/pair.ts`, `routes/oauth.ts`,
 * `routes/password.ts`) mint the row before any machine exists yet, so they
 * can't set it themselves.
 */

/** One query, reduced client-side to "first (most recent) row per machineId" —
 * cheaper than N per-machine queries and correct given `createdAt desc`. */
export async function computeMachinesNeedReauth(
  db: Database,
  accountId: string,
  machineIds: string[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (machineIds.length === 0) return result;

  const rows = await db.query.deviceSessions.findMany({
    where: and(
      eq(deviceSessions.accountId, accountId),
      eq(deviceSessions.clientKind, "cli-daemon"),
      inArray(deviceSessions.machineId, machineIds),
    ),
    orderBy: desc(deviceSessions.createdAt),
  });

  for (const row of rows) {
    // `machineId` is guaranteed non-null here (the `inArray` filter above
    // only matches non-null values), but the column itself is nullable.
    if (!row.machineId || result.has(row.machineId)) continue;
    result.set(row.machineId, row.revokedAt !== null);
  }
  return result;
}

/** Single-machine convenience wrapper — `routes/machines.ts`'s register/
 * update handlers and `socket.ts`'s machine-scoped disconnect handler each
 * only ever need one machine's answer at a time. */
export async function computeMachineNeedsReauth(
  db: Database,
  accountId: string,
  machineId: string,
): Promise<boolean> {
  const map = await computeMachinesNeedReauth(db, accountId, [machineId]);
  return map.get(machineId) ?? false;
}
