import { AppShell } from "@/components/app-shell";
import { RequireAuth } from "@/features/auth";

/** Shared client-side auth boundary and navigation shell for every account route. */
export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}
