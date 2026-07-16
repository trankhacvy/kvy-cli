"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { subscribePush, unsubscribePush } from "@/lib/api";
import { VAPID_PUBLIC_KEY } from "@/lib/config";
import { getToken, isSignedIn } from "@/lib/session";
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

// Push notification settings (design §9.2 Settings screen, FR-7.6/FR-8.3). Enable/disable
// only — per-session mute and mute-all (FR-8.3's "quiet controls") are separate, still-open
// plan.md §10 work; this is just the on/off toggle for the `webpush` channel.
export default function NotificationSettingsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("checking");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSignedIn()) {
      router.replace("/signin/");
      return;
    }

    const env = createBrowserPushEnvironment();
    if (!env.isSupported()) {
      setStatus("unsupported");
      return;
    }
    if (!VAPID_PUBLIC_KEY) {
      setStatus("no-vapid-key");
      return;
    }

    let cancelled = false;
    (async () => {
      const pushManager = await env.getPushManager();
      const existing = await pushManager.getSubscription();
      if (!cancelled) setStatus(existing ? "subscribed" : "unsubscribed");
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

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

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8 text-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          Get a push when a session needs your permission, asks a question, finishes, or fails —
          nothing else. Falcon never pushes on every message.
        </p>
      </div>

      {status === "checking" && <p className="text-sm text-muted-foreground">Checking…</p>}

      {status === "unsupported" && (
        <p className="text-sm text-muted-foreground">
          This browser doesn't support Web Push. On iOS, install Falcon to your home screen first
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
    </main>
  );
}
