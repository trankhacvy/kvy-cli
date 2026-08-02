"use client";

import type { SessionRow } from "@kvy/wire";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  getMutedAll,
  linkTelegram,
  listSessions,
  setMutedAll,
  setSessionMuted,
  subscribePush,
  unsubscribePush,
} from "@/lib/api";
import { VAPID_PUBLIC_KEY } from "@/lib/config";
import { getToken } from "@/lib/session";
import {
  createBrowserPushEnvironment,
  type PushApiPort,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/push/subscribe";

type Status =
  | "checking"
  | "unsupported"
  | "no-vapid-key"
  | "subscribed"
  | "unsubscribed"
  | "working";

// The real `PushApiPort` — wraps `lib/api.ts`'s HTTP calls so `src/push/subscribe.ts`'s
// orchestration logic stays testable against a fake (see push/__tests__/subscribe.test.ts).
const pushApi: PushApiPort = { subscribe: subscribePush, unsubscribe: unsubscribePush };

/**
 * verbatim out of the deleted `app/(protected)/settings/notifications/page.tsx`
 * route — page chrome dropped, behavior unchanged.
 */
export function NotificationsSection() {
  const [status, setStatus] = useState<Status>("checking");
  const [error, setError] = useState<string | null>(null);

  const [telegramDeepLink, setTelegramDeepLink] = useState<string | null>(null);
  const [telegramWorking, setTelegramWorking] = useState(false);
  const [telegramError, setTelegramError] = useState<string | null>(null);

  const [ntfyTopic, setNtfyTopic] = useState("");
  const [ntfySubscribed, setNtfySubscribed] = useState<string | null>(null);
  const [ntfyWorking, setNtfyWorking] = useState(false);
  const [ntfyError, setNtfyError] = useState<string | null>(null);

  const [mutedAll, setMutedAllState] = useState<boolean | null>(null);
  const [mutedAllError, setMutedAllError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);

  useEffect(() => {
    // One shared flag for every async load this effect kicks off, so a
    // single cleanup (below) guards all of them against a setState-after-
    // unmount — using a separate `cancelled` per load would leave the others
    // un-cancelled once the effect unmounts.
    let cancelled = false;

    const env = createBrowserPushEnvironment();
    if (!env.isSupported()) {
      setStatus("unsupported");
    } else if (!VAPID_PUBLIC_KEY) {
      setStatus("no-vapid-key");
    } else {
      (async () => {
        const pushManager = await env.getPushManager();
        const existing = await pushManager.getSubscription();
        if (!cancelled) setStatus(existing ? "subscribed" : "unsubscribed");
      })();
    }

    const token = getToken();
    if (token) {
      getMutedAll(token)
        .then((result) => {
          if (!cancelled) setMutedAllState(result.mutedAll);
        })
        .catch((err) => {
          if (!cancelled) {
            setMutedAllError(err instanceof Error ? err.message : "Failed to load mute setting");
          }
        });
      listSessions(token)
        .then((result) => {
          if (!cancelled) setSessions(result.sessions);
        })
        .catch((err) => {
          if (!cancelled) {
            setSessionsError(err instanceof Error ? err.message : "Failed to load sessions");
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    const token = getToken();
    if (!token || !VAPID_PUBLIC_KEY) return;
    setStatus("working");
    setError(null);
    try {
      const env = createBrowserPushEnvironment();
      const result = await subscribeToPush(env, pushApi, token, VAPID_PUBLIC_KEY);
      setStatus(result === "subscribed" ? "subscribed" : "unsupported");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to enable notifications");
      setStatus("unsubscribed");
    }
  }

  async function disable() {
    const token = getToken();
    if (!token) return;
    setStatus("working");
    setError(null);
    try {
      const env = createBrowserPushEnvironment();
      await unsubscribeFromPush(env, pushApi, token);
      setStatus("unsubscribed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable notifications");
      setStatus("subscribed");
    }
  }

  async function handleLinkTelegram() {
    const token = getToken();
    if (!token) return;
    setTelegramWorking(true);
    setTelegramError(null);
    try {
      const result = await linkTelegram(token);
      setTelegramDeepLink(result.deepLink);
      window.open(result.deepLink, "_blank", "noopener,noreferrer");
    } catch (err) {
      setTelegramError(err instanceof Error ? err.message : "Failed to create a Telegram link");
    } finally {
      setTelegramWorking(false);
    }
  }

  async function handleSubscribeNtfy(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const token = getToken();
    const topic = ntfyTopic.trim();
    if (!token || !topic) return;
    setNtfyWorking(true);
    setNtfyError(null);
    try {
      await subscribePush(token, { channel: "ntfy", endpoint: topic });
      setNtfySubscribed(topic);
    } catch (err) {
      setNtfyError(err instanceof Error ? err.message : "Failed to subscribe via ntfy");
    } finally {
      setNtfyWorking(false);
    }
  }

  async function handleToggleMutedAll() {
    const token = getToken();
    if (!token || mutedAll === null) return;
    const next = !mutedAll;
    setMutedAllState(next); // optimistic
    setMutedAllError(null);
    try {
      await setMutedAll(token, next);
    } catch (err) {
      setMutedAllState(!next); // revert
      setMutedAllError(err instanceof Error ? err.message : "Failed to update");
    }
  }

  async function handleToggleSessionMute(session: SessionRow) {
    const token = getToken();
    if (!token) return;
    const next = !session.notificationsMuted;
    setPendingSessionId(session.id);
    setSessionsError(null);
    setSessions(
      (prev) =>
        prev?.map((s) => (s.id === session.id ? { ...s, notificationsMuted: next } : s)) ?? prev,
    );
    try {
      await setSessionMuted(token, session.id, next);
    } catch (err) {
      setSessions(
        (prev) =>
          prev?.map((s) => (s.id === session.id ? { ...s, notificationsMuted: !next } : s)) ?? prev,
      );
      setSessionsError(err instanceof Error ? err.message : "Failed to update session mute");
    } finally {
      setPendingSessionId(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-muted-foreground">
        Get a push when a session needs your permission, asks a question, finishes, or fails,
        nothing else. Kvy never pushes on every message.
      </p>

      <section className="flex flex-col items-start gap-3">
        {status === "checking" && <p className="text-sm text-muted-foreground">Checking…</p>}

        {status === "unsupported" && (
          <p className="text-sm text-muted-foreground">
            This browser doesn't support Web Push. On iOS, install Kvy to your home screen first
            (Share → Add to Home Screen).
          </p>
        )}

        {status === "no-vapid-key" && (
          <p className="text-sm text-destructive">
            Push notifications aren't configured on this server yet.
          </p>
        )}

        {status === "unsubscribed" && (
          <Button type="button" onClick={enable}>
            Enable push notifications
          </Button>
        )}

        {status === "subscribed" && (
          <Button type="button" variant="outline" onClick={disable}>
            Disable push notifications
          </Button>
        )}

        {status === "working" && <p className="text-sm text-muted-foreground">Working…</p>}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">Fallback channels</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Web Push is unreliable on iOS. Link Telegram or ntfy as a backup: same events, same
            rules, no session content.
          </p>
        </div>

        <div className="flex flex-col items-start gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={telegramWorking}
            onClick={handleLinkTelegram}
          >
            {telegramWorking ? "Working…" : "Link Telegram"}
          </Button>
          {telegramDeepLink && (
            <p className="text-sm text-muted-foreground">
              Opened Telegram to finish pairing. Didn't open?{" "}
              <a
                href={telegramDeepLink}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Tap here
              </a>
              .
            </p>
          )}
          {telegramError && <p className="text-sm text-destructive">{telegramError}</p>}
        </div>

        <form onSubmit={handleSubscribeNtfy} className="flex flex-col gap-2">
          <label htmlFor="ntfy-topic" className="text-sm font-medium">
            ntfy topic
          </label>
          <div className="flex gap-2">
            <input
              id="ntfy-topic"
              type="text"
              value={ntfyTopic}
              onChange={(e) => setNtfyTopic(e.target.value)}
              placeholder="my-kvy-topic"
              className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button type="submit" variant="outline" disabled={ntfyWorking || !ntfyTopic.trim()}>
              {ntfyWorking ? "Working…" : "Subscribe"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Pick any topic name and subscribe to it in the ntfy app (or at ntfy.sh/&lt;topic&gt;).
          </p>
          {ntfySubscribed && (
            <p className="text-sm text-muted-foreground">
              Subscribed to ntfy topic "{ntfySubscribed}".
            </p>
          )}
          {ntfyError && <p className="text-sm text-destructive">{ntfyError}</p>}
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">Quiet controls</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Mute everything, or just one session.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={mutedAll ?? false}
            disabled={mutedAll === null}
            onChange={handleToggleMutedAll}
          />
          Mute all notifications
        </label>
        {mutedAllError && <p className="text-sm text-destructive">{mutedAllError}</p>}

        {sessions && sessions.length > 0 && (
          <ul className="flex flex-col gap-1">
            {sessions.map((session) => (
              <li key={session.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={session.notificationsMuted}
                    disabled={pendingSessionId === session.id}
                    onChange={() => handleToggleSessionMute(session)}
                  />
                  <span className="truncate">{session.tag}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {sessions && sessions.length === 0 && (
          <p className="text-sm text-muted-foreground">No sessions yet.</p>
        )}
        {sessionsError && <p className="text-sm text-destructive">{sessionsError}</p>}
      </section>
    </div>
  );
}
