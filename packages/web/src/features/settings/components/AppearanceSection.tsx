"use client";

import { DownloadIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { usePwaInstall } from "@/hooks/use-pwa-install";
import { useTheme } from "@/lib/use-theme";

export function AppearanceSection() {
  const [theme, setTheme] = useTheme();
  const { canInstall, isInstalled, install } = usePwaInstall();
  const [installBusy, setInstallBusy] = useState(false);
  const [installNote, setInstallNote] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Kvy defaults to dark. Switch to light if you&apos;d rather.
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
