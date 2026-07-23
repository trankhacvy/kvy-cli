"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "@/lib/use-theme";

/**
 * Root TanStack Query provider (falcon-system-design.md §9.1: "React Query
 * owns request-shaped state"). One `QueryClient` per app instance, created
 * lazily inside `useState` rather than at module scope — the static-export
 * build still runs this file's module body during prerendering, and a
 * module-scope client would be shared across every prerendered route.
 *
 * Also the one place sonner's `<Toaster />` is mounted, since it's wanted on
 * every screen, not a per-route concern. `theme` follows `useTheme()` so a
 * toast never looks dark-on-dark/light-on-light against whichever theme the
 * user has picked (Settings → Appearance, in the settings dialog).
 *
 * `OfflineBanner` used to mount here too (plan-v2.md W4.2) but moved to
 * `app/(protected)/layout.tsx` — it has nothing meaningful to report on a
 * public route, where no socket connection is ever attempted (known-issues.md
 * "OfflineBanner shows a misleading 'Reconnecting…' on pages with no
 * connection to reconnect").
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [theme] = useTheme();
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {children}
        <Toaster theme={theme} richColors closeButton position="bottom-right" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
