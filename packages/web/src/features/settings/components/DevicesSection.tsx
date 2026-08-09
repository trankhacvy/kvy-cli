"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SIGNIN_PATH } from "@/features/auth";
import { listDeviceSessions, renameSession, revokeOtherSessions, revokeSession } from "@/lib/api";
import { copy } from "@/lib/copy";
import { clientKindLabel, deviceSessionLabel } from "@/lib/device-session-label";
import { logout } from "@/lib/logout";
import { getToken } from "@/lib/session";
import { cancelRename, isRenaming, type RenamingId, startRename } from "../devices-rename-state";
import {
  canConfirmRevoke,
  clearRevokeConfirm,
  type RevokeConfirmId,
  requestRevoke,
} from "../devices-revoke-state";

type DeviceSession = Awaited<ReturnType<typeof listDeviceSessions>>["sessions"][number];

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
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | "others" | null>(null);
  const [confirmId, setConfirmId] = useState<RevokeConfirmId>(null);
  const [renamingId, setRenamingId] = useState<RenamingId>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [renamePending, setRenamePending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const token = getToken();
    if (!token) return;
    listDeviceSessions(token)
      .then((result) => {
        if (!cancelled) {
          setSessions(result.sessions);
          setEmail(result.email);
        }
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

  function requestRenameClick(session: DeviceSession): void {
    setError(null);
    setDraftLabel(deviceSessionLabel(session));
    setRenamingId(startRename(session.id));
  }

  function cancelRenameClick(): void {
    setRenamingId(cancelRename());
  }

  async function confirmRename(session: DeviceSession): Promise<void> {
    if (!isRenaming(renamingId, session.id)) return;
    const label = draftLabel.trim();
    if (!label) return;
    const token = getToken();
    if (!token) return;
    setRenamePending(true);
    setError(null);
    try {
      const result = await renameSession(token, session.id, label);
      setSessions(
        (prev) =>
          prev?.map((s) => (s.id === session.id ? { ...s, label: result.label } : s)) ?? prev,
      );
      setRenamingId(cancelRename());
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.devices.renameError);
    } finally {
      setRenamePending(false);
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
            {email
              ? `Signed in as ${email}. Every device currently signed in to your account.`
              : "Every device currently signed in to your account."}
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

      <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        {copy.devices.explainer}
      </p>

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
                  {deviceSessionLabel(session)}
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
              {isRenaming(renamingId, session.id) ? (
                <div className="flex items-center gap-2">
                  <Input
                    autoFocus
                    value={draftLabel}
                    onChange={(e) => setDraftLabel(e.target.value)}
                    placeholder={copy.devices.renamePlaceholder}
                    maxLength={80}
                    className="h-8 w-40"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={renamePending || draftLabel.trim().length === 0}
                    onClick={() => confirmRename(session)}
                  >
                    {renamePending ? "Working…" : copy.devices.renameSaveCta}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={cancelRenameClick}>
                    {copy.devices.renameCancelCta}
                  </Button>
                </div>
              ) : confirmId === session.id ? (
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
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pendingId !== null || renamePending}
                    onClick={() => requestRenameClick(session)}
                  >
                    {copy.devices.renameCta}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pendingId !== null}
                    onClick={() => requestRevokeClick(session)}
                  >
                    {session.isCurrent ? "Log out this device" : "Log out"}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
