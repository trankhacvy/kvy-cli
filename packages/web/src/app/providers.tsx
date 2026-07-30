"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ensureInstallListeners } from "@/lib/pwa-install";
import { registerServiceWorker } from "@/lib/register-sw";
import { useTheme } from "@/lib/use-theme";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [theme] = useTheme();

  useEffect(() => {
    ensureInstallListeners();
    // The SW caches JS/CSS/static assets and serves them stale-first, which
    // makes `next dev` iteration look like the browser "won't pick up" code
    // changes. Only register it in production builds.
    if (process.env.NODE_ENV === "production") {
      void registerServiceWorker();
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {children}
        <Toaster theme={theme} richColors closeButton position="bottom-right" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
