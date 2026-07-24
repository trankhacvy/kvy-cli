"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SIGNIN_PATH } from "@/features/auth";
import { listDeviceSessions, revokeOtherSessions, revokeSession } from "@/lib/api";
import { logout } from "@/lib/logout";
import { getToken } from "@/lib/session";
import {
  canConfirmRevoke,
  clearRevokeConfirm,
  type RevokeConfirmId,
  requestRevoke,
} from "../devices-revoke-state";

type DeviceSession = Awaited<ReturnType<typeof listDeviceSessions>>["sessions"][number];

const CLIENT_KIND_LABELS: Record<string, string> = {
  web: "Web browser",
  "cli-daemon": "CLI daemon",
  "cli-session": "CLI session",
  "cloud-sandbox": "Cloud sandbox",
};

function clientKindLabel(clientKind: string): string {
  return CLIENT_KIND_LABELS[clientKind] ?? clientKind;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

/**
 * Settings → Devices — security review finding F2: `GET /v1/auth/sessions` +
 * `POST /v1/auth/sessions/:id/revoke` + `POST /v1/auth/sessions/revoke-others`
 * (`sessionsAdmin.ts`, issue-4-plan.md §4.4) existed, were tested, and had nothing
 * calling them from the web app. This lists the account's active `device_sessions`
 * and offers "log out this device" (revokes the CURRENT session, then runs the same
 * local teardown `nav-user.tsx`'s sign-out button does) and "log out all other
 * devices" (bulk-revokes everything else). Revocation is immediate on the server side
 * regardless — `sessionsAdmin.ts` disconnects the revoked session's live socket right
 * away rather than waiting for its access token to expire — this screen's own
 * optimistic list update/redirect is just this device's own UI catching up.
 */
export function DevicesSection() {
  const router = useRouter();
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | "others" | null>(null);
  const [confirmId, setConfirmId] = useState<RevokeConfirmId>(null);

  useEffect(() => {
    let cancelled = false;
    const token = getToken();
    if (!token) return;
    listDeviceSessions(token)
      .then((result) => {
        if (!cancelled) setSessions(result.sessions);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load devices");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** First click on a row's "Log out" trigger — shows the inline
   * confirm/cancel affordance instead of revoking immediately (a misclick
   * here is destructive and, for the current-device row, a full sign-out). */
  function requestRevokeClick(session: DeviceSession): void {
    setError(null);
    setConfirmId(requestRevoke(session.id));
  }

  /** Second click ("Confirm") — the only path that's allowed to reach the
   * real `revokeSession` call. */
  async function confirmRevoke(session: DeviceSession): Promise<void> {
    if (!canConfirmRevoke(confirmId, session.id)) return;
    setConfirmId(clearRevokeConfirm());
    await handleRevoke(session);
  }

  async function handleRevoke(session: DeviceSession) {
    const token = getToken();
    if (!token) return;
    setPendingId(session.id);
    setError(null);
    try {
      await revokeSession(token, session.id);
      if (session.isCurrent) {
        // This device's own session is now dead server-side — tear down local state
        // the same way the sidebar's "Log out" button does, rather than leaving the
        // UI showing a session that will fail on its next silent refresh anyway.
        await logout();
        router.replace(SIGNIN_PATH);
        return;
      }
      setSessions((prev) => prev?.filter((s) => s.id !== session.id) ?? prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to log out that device");
    } finally {
      setPendingId(null);
    }
  }

  async function handleRevokeOthers() {
    const token = getToken();
    if (!token) return;
    setPendingId("others");
    setError(null);
    try {
      await revokeOtherSessions(token);
      setSessions((prev) => prev?.filter((s) => s.isCurrent) ?? prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to log out other devices");
    } finally {
      setPendingId(null);
    }
  }

  const otherCount = sessions?.filter((s) => !s.isCurrent).length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Devices</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Every device currently signed in to your account.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={otherCount === 0 || pendingId !== null}
          onClick={handleRevokeOthers}
        >
          {pendingId === "others" ? "Working…" : "Log out all other devices"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {sessions === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

      {sessions && sessions.length === 0 && (
        <p className="text-sm text-muted-foreground">No active devices.</p>
      )}

      {sessions && sessions.length > 0 && (
        <ul className="flex flex-col gap-2">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {session.label ?? clientKindLabel(session.clientKind)}
                  {session.isCurrent && (
                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                      This device
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {clientKindLabel(session.clientKind)} · last used{" "}
                  {formatRelative(session.lastRefreshedAt ?? session.createdAt)}
                </p>
              </div>
              {confirmId === session.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {session.isCurrent ? "Log out this browser?" : "Log out this device?"}
                  </span>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={pendingId !== null}
                    onClick={() => confirmRevoke(session)}
                  >
                    {pendingId === session.id ? "Working…" : "Confirm"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmId(clearRevokeConfirm())}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pendingId !== null}
                  onClick={() => requestRevokeClick(session)}
                >
                  {session.isCurrent ? "Log out this device" : "Log out"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
