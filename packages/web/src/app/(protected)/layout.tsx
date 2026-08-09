import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { OfflineBanner } from "@/components/OfflineBanner";
import { PwaInstallBanner } from "@/components/PwaInstallBanner";
import { RequireAuth } from "@/features/auth";
import { WorkspaceIndexProvider } from "@/features/session-list/workspace-index-context";
import { NO_INDEX_ROBOTS } from "@/lib/seo";

export const metadata: Metadata = {
  robots: NO_INDEX_ROBOTS,
};

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <WorkspaceIndexProvider>
        {/*
         * `h-svh` pins this column to the viewport height; the banners below
         * are `shrink-0` so `AppShell` (flex-1) gives up exactly their height
         * instead of the whole column growing past the viewport and pushing
         * the session composer (pinned to `AppShell`'s own bottom) offscreen.
         */}
        <div className="flex h-svh flex-col overflow-hidden">
          <OfflineBanner />
          <PwaInstallBanner />
          <AppShell>{children}</AppShell>
        </div>
      </WorkspaceIndexProvider>
    </RequireAuth>
  );
}
