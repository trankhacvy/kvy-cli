"use client";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/use-theme";

export default function AppearanceSettingsPage() {
  const [theme, setTheme] = useTheme();

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center gap-8 p-8 text-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Appearance</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Falcon defaults to dark. Switch to light if you'd rather.
        </p>
      </div>

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
    </main>
  );
}
