"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

/**
 * Root TanStack Query provider (falcon-system-design.md §9.1: "React Query
 * owns request-shaped state"). One `QueryClient` per app instance, created
 * lazily inside `useState` rather than at module scope — the static-export
 * build still runs this file's module body during prerendering, and a
 * module-scope client would be shared across every prerendered route.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
