"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Toaster } from "sonner";
import { OfflineBanner } from "@/components/OfflineBanner";
import { useTheme } from "@/lib/use-theme";

/**
 * Root TanStack Query provider (falcon-system-design.md §9.1: "React Query
 * owns request-shaped state"). One `QueryClient` per app instance, created
 * lazily inside `useState` rather than at module scope — the static-export
 * build still runs this file's module body during prerendering, and a
 * module-scope client would be shared across every prerendered route.
 *
 * Also the one place `OfflineBanner` (plan-v2.md W4.2) and sonner's
 * `<Toaster />` are mounted — both are app-chrome, wanted on every screen,
 * not per-route concerns. `Toaster`'s `theme` follows `useTheme()` so a
 * toast never looks dark-on-dark/light-on-light against whichever theme the
 * user has picked (`app/settings/appearance`).
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [theme] = useTheme();
  return (
    <QueryClientProvider client={queryClient}>
      <OfflineBanner />
      {children}
      <Toaster theme={theme} richColors closeButton position="bottom-right" />
    </QueryClientProvider>
  );
}
