"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { isSignedIn } from "@/lib/session";
import { useTheme } from "@/lib/use-theme";

/**
 * Appearance settings (design §9.2 Settings screen, plan-v2.md W4.2 "theme
 * toggle"). Falcon defaults to dark (design §9 stack table); this is the
 * one screen that can flip it — `useTheme()` is backed by a shared
 * `localStorage`-persisted store (`use-theme.ts`), same
 * gate-then-render pattern as `settings/notifications/page.tsx`.
 */
export default function AppearanceSettingsPage() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    if (!isSignedIn()) {
      router.replace("/signin/");
      return;
    }
    setChecked(true);
  }, [router]);

  if (!checked) return null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center gap-8 p-8 text-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Appearance</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Falcon defaults to dark. Switch to light if you'd rather.
        </p>
      </div>

      <div className="flex gap-2" role="radiogroup" aria-label="Theme">
        <Button
          type="button"
          variant={theme === "dark" ? "default" : "outline"}
          aria-pressed={theme === "dark"}
          onClick={() => setTheme("dark")}
        >
          Dark
        </Button>
        <Button
          type="button"
          variant={theme === "light" ? "default" : "outline"}
          aria-pressed={theme === "light"}
          onClick={() => setTheme("light")}
        >
          Light
        </Button>
      </div>
    </main>
  );
}
