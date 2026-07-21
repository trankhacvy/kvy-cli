import { AppShell } from "@/components/app-shell";
import { OfflineBanner } from "@/components/OfflineBanner";
import { RequireAuth } from "@/features/auth";

/**
 * Shared client-side auth boundary and navigation shell for every account route.
 *
 * `OfflineBanner` mounts here (not globally in `app/providers.tsx`, where it used to
 * live) because `apiSocket.connect()` is only ever called from `use-sync-snapshot.ts`,
 * which only mounts inside these authenticated screens (known-issues.md "OfflineBanner
 * shows a misleading 'Reconnecting…' on pages with no connection to reconnect"). On a
 * public route (`/signin/`, `/pair/`, `/auth/callback/*`) no connection is ever
 * attempted, so `wsConnected`/`authExpired` never reflect anything real there — the
 * banner has nothing meaningful to report on those routes and shouldn't render at all.
 */
export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <OfflineBanner />
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}
