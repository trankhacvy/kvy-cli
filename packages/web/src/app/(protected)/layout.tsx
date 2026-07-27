import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { OfflineBanner } from "@/components/OfflineBanner";
import { RequireAuth } from "@/features/auth";
import { NO_INDEX_ROBOTS } from "@/lib/seo";

export const metadata: Metadata = {
  robots: NO_INDEX_ROBOTS,
};

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <OfflineBanner />
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}
