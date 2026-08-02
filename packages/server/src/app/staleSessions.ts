import { and, eq } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import { sessions } from "../db/schema.js";
import { allocHeaderSeq } from "../db/seq.js";
import type { Database } from "../db/types.js";
import type { EventRouterPort } from "./events/eventRouter.js";
import type { PushDispatcherPort } from "./push/types.js";

type SessionRow = typeof sessions.$inferSelect;

/**
 * known-issues.md #8: a session whose machine loses power / gets `kill -9`d
 * never gets a chance to run `start.ts`'s clean-exit/signal `reportStatusOnce`
 * (`POST /v1/sessions/:id/status`), so its row stays `status: "active"`
 * forever — nothing server-side ever times it out.
 *
 * Lazy, on-read reconciliation instead of a background sweep: this codebase
 * deliberately has no cron/scheduled-job infrastructure (`app/api/pair.ts`'s
 * `expiresAt` comment — "checked [when read]", not swept), and a session's
 * status is a small enough thing to re-derive on every read that a second,
 * multi-instance-unsafe background timer isn't worth the departure. Every
 * route that would otherwise hand a client a `status: "active"` session
 * (`routes/sessions.ts`'s list, `routes/sync.ts`'s snapshot) runs its batch
 * through `reconcileStaleSessions` first.
 *
 * Threshold: more generous than `use-machine-presence.ts`'s
 * `MACHINE_ONLINE_WINDOW_MS` (3 min = 3 missed 60s heartbeats, used only for
 * an "offline" badge) because flipping a session to `failed` is a much
 * harder-to-reverse action than toggling a badge — a machine that's merely
 * slow to heartbeat (temporary network hiccup, laptop sleep/wake) shouldn't
 * have its live session's status clobbered. 5 minutes = 5 missed heartbeats,
 * clearly past the point a genuinely-alive daemon would have reconnected.
 */
export const STALE_SESSION_MACHINE_WINDOW_MS = 5 * 60_000;

/**
 * A session is presumed orphaned only when BOTH signals agree it's gone:
 * its owning machine hasn't heartbeated in `STALE_SESSION_MACHINE_WINDOW_MS`
 * AND the session row itself hasn't been touched in that same window either
 * (`allocMsgSeq` bumps `sessions.updatedAt` on every real chat message —
 * known-issues.md #10 — so this is a genuine "no activity" signal, not just
 * a proxy). Requiring both avoids flipping a session on a merely-stale
 * `machines` row (e.g. a multi-machine account glitch) that's still seeing
 * real traffic some other way.
 *
 * A `null`/unknown `lastSeenAt` (never heartbeated, or the session has no
 * `machineId` at all) is deliberately treated as "not stale" — no confident
 * signal to act on, so this never guesses a session is dead.
 */
export function isSessionOrphaned(
  session: Pick<SessionRow, "status" | "machineId" | "updatedAt">,
  machineLastSeenAt: Date | null | undefined,
  now: number,
): boolean {
  if (session.status !== "active" || !session.machineId || !machineLastSeenAt) return false;
  const machineStale = now - machineLastSeenAt.getTime() > STALE_SESSION_MACHINE_WINDOW_MS;
  const sessionQuiet = now - session.updatedAt.getTime() > STALE_SESSION_MACHINE_WINDOW_MS;
  return machineStale && sessionQuiet;
}

type FailOutcome =
  | { outcome: "updated"; headerSeq: number }
  | { outcome: "already-transitioned" }
  | { outcome: "not-found" };

/**
 * Flips exactly one orphaned session to `failed`. Race-safe against a
 * genuine concurrent writer (the CLI's own `POST /v1/sessions/:id/status`
 * report, or a second simultaneous reconcile call on the same session from
 * another request): the guard is "current status is still exactly
 * `active`", re-asserted in the `UPDATE ... WHERE` clause AND verified via
 * `.returning()` — NOT `sessionStatus.ts`'s own idempotency check (which
 * only compares against the *target* status and never checks affected rows,
 * since it has no second writer to race). That distinction matters here
 * because this function specifically can lose a race the WHERE clause alone
 * doesn't surface — see the comment at the `.returning()` call below.
 */
async function failOrphanedSession(
  db: Database,
  accountId: string,
  sessionId: string,
): Promise<FailOutcome> {
  return db.transaction(async (tx) => {
    const session = await tx.query.sessions.findFirst({
      where: and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)),
    });
    if (!session) return { outcome: "not-found" as const };
    if (session.status !== "active") return { outcome: "already-transitioned" as const };

    // `.returning()` + length check — not just the `WHERE status = 'active'`
    // clause above — is the actual guard, matching `sessionCas.ts`/
    // `refresh.ts`/`pair.ts`'s established CAS pattern in this codebase.
    // Under READ COMMITTED (the default, unchanged here), each statement in
    // this transaction re-evaluates against the latest committed data, so a
    // concurrent writer (the CLI's own genuine status report, or a second
    // simultaneous reconcile call racing on the same stale session — e.g.
    // two browser tabs both hitting `GET /v1/sync`) can still land between
    // the read above and this statement even though it read "active"
    // moments ago. Without checking the returned rows, this function would
    // believe it won and fan out a false `session-update`/`attention`/push
    // for a change that never actually happened in the DB.
    const updated = await tx
      .update(sessions)
      .set({ status: "failed", updatedAt: new Date() })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.accountId, accountId),
          eq(sessions.status, "active"),
        ),
      )
      .returning();

    if (updated.length === 0) return { outcome: "already-transitioned" as const };

    const headerSeq = await allocHeaderSeq(tx, accountId);
    return { outcome: "updated" as const, headerSeq };
  });
}

/**
 * Same fan-out shape as `sessionStatus.ts`'s `failed` path (session-update +
 * `attention` ephemeral + push dispatch) so web clients pick this up
 * identically to a self-reported failure, with no new client-side code.
 * Deferred to `reply.raw`'s `finish` event for the same reason as every
 * response has actually been sent).
 */
function fanOutOrphanedSession(
  reply: FastifyReply,
  eventRouter: EventRouterPort,
  pushDispatcher: PushDispatcherPort,
  params: { accountId: string; sessionId: string; headerSeq: number },
): void {
  const { accountId, sessionId, headerSeq } = params;
  reply.raw.once("finish", () => {
    eventRouter.emitUpdate({
      accountId,
      recipientFilter: { type: "all-interested-in-session", sessionId },
      payload: {
        seq: headerSeq,
        ts: Date.now(),
        body: { t: "session-update", id: sessionId, status: "failed" },
      },
    });
    eventRouter.emitEphemeral({
      accountId,
      recipientFilter: { type: "all-interested-in-session", sessionId },
      payload: { t: "attention", sessionId, kind: "failed" },
    });
    void pushDispatcher.dispatch({ accountId, sessionId, kind: "failed" });
  });
}

/**
 * Runs a batch of already-fetched session rows (one page of `GET
 * /v1/sessions`, or a whole `GET /v1/sync` snapshot) through orphan
 * detection, flips any that qualify, and returns the same rows with
 * flipped ones reflecting their new `status`/`updatedAt` — so the caller's
 * existing `toSessionRow` mapping downstream sees the corrected state
 * without a re-fetch.
 *
 * `machineLastSeenById` is supplied by the caller rather than queried here:
 * `routes/sync.ts` already fetches every machine for the account in the
 * same request and can build the map for free; `routes/sessions.ts` builds
 * a small one scoped to just the machine ids referenced by its page.
 */
export async function reconcileStaleSessions(
  db: Database,
  eventRouter: EventRouterPort,
  pushDispatcher: PushDispatcherPort,
  reply: FastifyReply,
  accountId: string,
  sessionRows: SessionRow[],
  machineLastSeenById: Map<string, Date | null>,
  now: number = Date.now(),
): Promise<SessionRow[]> {
  const result: SessionRow[] = [];
  for (const row of sessionRows) {
    const lastSeenAt = row.machineId ? machineLastSeenById.get(row.machineId) : undefined;
    if (!isSessionOrphaned(row, lastSeenAt, now)) {
      result.push(row);
      continue;
    }

    const outcome = await failOrphanedSession(db, accountId, row.id);
    if (outcome.outcome === "updated") {
      fanOutOrphanedSession(reply, eventRouter, pushDispatcher, {
        accountId,
        sessionId: row.id,
        headerSeq: outcome.headerSeq,
      });
      result.push({ ...row, status: "failed", updatedAt: new Date(now) });
    } else {
      // "already-transitioned": a genuine concurrent report won the race —
      // reflect whatever it actually landed, not our guess. "not-found" is
      // unreachable in practice (the row was just read moments ago) but
      // handled the same way for safety.
      result.push(row);
    }
  }
  return result;
}
