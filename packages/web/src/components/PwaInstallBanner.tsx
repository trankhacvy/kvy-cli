"use client";

import { CheckIcon, DownloadIcon, ShareIcon, SquarePlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePwaInstall } from "@/hooks/use-pwa-install";
import { isIosDevice } from "@/lib/pwa-install";
import { cn } from "@/lib/utils";
import {
  dismissInstallBanner,
  getInstallBannerDismissed,
  getInstallBannerMode,
} from "./pwa-install-banner-state";

const HOW_TO_STEPS = [
  { Icon: ShareIcon, text: "Tap the Share icon in Safari's toolbar" },
  { Icon: SquarePlusIcon, text: "Scroll down, tap Add to Home Screen" },
  { Icon: CheckIcon, text: "Tap Add — Kvy now opens like a real app" },
];

function HowToInstallSteps() {
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setActiveStep((step) => (step + 1) % HOW_TO_STEPS.length);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-center gap-3 rounded-lg bg-muted py-6">
        {HOW_TO_STEPS.map(({ Icon, text }, index) => (
          <div
            key={text}
            className={cn(
              "flex size-9 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-all",
              index === activeStep && "scale-110 border-primary text-primary",
            )}
          >
            <Icon className="size-4" />
          </div>
        ))}
      </div>
      <ol className="flex flex-col gap-2 text-sm">
        {HOW_TO_STEPS.map(({ text }, index) => (
          <li key={text} className="flex items-start gap-2">
            <span className="mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full bg-accent text-[0.65rem] font-semibold text-accent-foreground">
              {index + 1}
            </span>
            {text}
          </li>
        ))}
      </ol>
    </div>
  );
}

function HowToInstallDialog({
  open,
  onOpenChange,
  onDismissForever,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismissForever: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Kvy to your Home Screen</DialogTitle>
          <DialogDescription>
            Safari doesn't allow one-tap install — three quick taps instead:
          </DialogDescription>
        </DialogHeader>
        <HowToInstallSteps />
        <DialogFooter>
          <button
            type="button"
            onClick={onDismissForever}
            className="mr-auto text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            Don't show again
          </button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Mounted in `app/(protected)/layout.tsx` next to `OfflineBanner`. Not
 * gated on "first login" — client-side detection can't tell a genuinely
 * new account from a returning one across every sign-in method (OAuth
 * never distinguishes new vs. returning, and CLI-paired users often use
 * Kvy for a while before ever opening the web app). Showing until
 * installed or dismissed reaches the same users in practice, without
 * needing server state for it.
 */
export function PwaInstallBanner() {
  const { canInstall, isInstalled, install } = usePwaInstall();
  const [dismissed, setDismissed] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [howToOpen, setHowToOpen] = useState(false);

  useEffect(() => {
    setDismissed(getInstallBannerDismissed());
    setIsIos(isIosDevice());
    setMounted(true);
  }, []);

  // `canInstall` comes from `useSyncExternalStore` and can already be `true`
  // synchronously on a component's first render (e.g. a client-side
  // navigation mounting this for the first time after `beforeinstallprompt`
  // already fired elsewhere in the session) - `dismissed`/`isIos` above
  // can't, since they only resolve once the mount effect runs. Gating on
  // `mounted` keeps every input resolved together, so a previously-dismissed
  // user never sees a one-frame flash of the banner before it hides again.
  const mode = mounted
    ? getInstallBannerMode({ isInstalled, dismissed, canInstall, isIos })
    : "hidden";

  function handleDismiss(): void {
    dismissInstallBanner();
    setDismissed(true);
    setHowToOpen(false);
  }

  function handleInstallClick(): void {
    setInstallBusy(true);
    void install()
      .catch(() => {})
      .finally(() => setInstallBusy(false));
  }

  if (mode === "hidden") return null;

  return (
    <>
      <section aria-label="Install Kvy" className="border-b border-border bg-accent px-4 py-2">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
          <span className="text-center text-sm text-accent-foreground">
            <span className="hidden sm:inline">
              <strong className="font-medium">Get faster access</strong> and reliable notifications
              — add Kvy to your home screen.
            </span>
            <span className="sm:hidden">
              <strong className="font-medium">Faster access</strong> + real notifications
            </span>
          </span>
          <div className="flex shrink-0 items-center gap-2.5">
            {mode === "install" ? (
              <Button type="button" size="sm" disabled={installBusy} onClick={handleInstallClick}>
                <DownloadIcon data-icon="inline-start" />
                {installBusy ? "Installing…" : "Install"}
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={() => setHowToOpen(true)}>
                How to install
              </Button>
            )}
            <button
              type="button"
              onClick={handleDismiss}
              className="hidden text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground sm:inline"
            >
              Don't show again
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={handleDismiss}
              aria-label="Don't show again"
              className="sm:hidden"
            >
              <XIcon />
            </Button>
          </div>
        </div>
      </section>
      {mode === "how-to" && (
        <HowToInstallDialog
          open={howToOpen}
          onOpenChange={setHowToOpen}
          onDismissForever={handleDismiss}
        />
      )}
    </>
  );
}
