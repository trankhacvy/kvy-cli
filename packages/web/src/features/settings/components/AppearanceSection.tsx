"use client";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/use-theme";

/**
 * Settings → Appearance (moved verbatim out of the deleted
 * `app/(protected)/settings/appearance/page.tsx` route — page chrome
 * dropped, behavior unchanged): Falcon defaults to dark; switch to light if
 * you'd rather. Per-device `localStorage` preference via `use-theme.ts`.
 */
export function AppearanceSection() {
  const [theme, setTheme] = useTheme();

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Falcon defaults to dark. Switch to light if you'd rather.
      </p>

      <div className="flex gap-2">
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
    </div>
  );
}
