"use client";

import { DownloadIcon, type LucideIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { usePwaInstall } from "@/hooks/use-pwa-install";
import type { Theme } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";

const THEME_OPTIONS: Array<{ value: Theme; label: string; Icon: LucideIcon }> = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "Match system", Icon: MonitorIcon },
];

export function AppearanceSection() {
  const [theme, setTheme] = useTheme();
  const { canInstall, isInstalled, install } = usePwaInstall();
  const [installBusy, setInstallBusy] = useState(false);
  const [installNote, setInstallNote] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Kvy defaults to dark. Switch to light, or match your system.
        </p>

        <fieldset
          aria-label="Theme"
          className="inline-flex w-fit gap-0.5 rounded-lg border-0 bg-muted p-1"
        >
          {THEME_OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
              className={cn(
                "flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                theme === value && "bg-accent text-accent-foreground",
              )}
            >
              <Icon className="size-4" />
            </button>
          ))}
        </fieldset>
      </section>

      <section className="flex flex-col items-start gap-3">
        <div>
          <h3 className="font-medium text-sm">Install app</h3>
          <p className="mt-1 text-muted-foreground text-sm">
            Add Kvy to your home screen for a standalone window and more reliable notifications on
            mobile.
          </p>
        </div>
        {isInstalled ? (
          <p className="text-muted-foreground text-sm">Kvy is installed on this device.</p>
        ) : canInstall ? (
          <Button
            type="button"
            variant="outline"
            disabled={installBusy}
            onClick={() => {
              setInstallBusy(true);
              setInstallNote(null);
              void install()
                .then((outcome) => {
                  if (outcome === "dismissed") {
                    setInstallNote("Install was dismissed.");
                  } else if (outcome === "unavailable") {
                    setInstallNote("Install is not available in this browser right now.");
                  }
                })
                .finally(() => setInstallBusy(false));
            }}
          >
            <DownloadIcon data-icon="inline-start" />
            {installBusy ? "Installing…" : "Install Kvy"}
          </Button>
        ) : (
          <p className="text-muted-foreground text-sm">
            Use your browser&apos;s &ldquo;Install app&rdquo; or &ldquo;Add to Home Screen&rdquo;
            menu if this device supports it.
          </p>
        )}
        {installNote ? <p className="text-muted-foreground text-sm">{installNote}</p> : null}
      </section>
    </div>
  );
}
