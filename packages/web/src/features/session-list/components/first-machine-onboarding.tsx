"use client";

import { Check, Copy, Loader2 } from "lucide-react";
import { useState } from "react";
import { InstallTabs } from "@/components/install-tabs";
import { copy } from "@/lib/copy";

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
      <code className="flex-1 overflow-x-auto font-mono text-xs">{command}</code>
      <button
        type="button"
        aria-label={`Copy: ${command}`}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

/**
 * Shown instead of "No sessions yet" when the account has NO machines at all. The old
 * empty state told the user to run `kvy` "on any paired machine" — when they had none
 * — and offered a "New session" button that needs a machine to work.
 *
 * Advances by itself: the parent re-renders from the same `['sync']` snapshot the socket
 * keeps fresh, so registering a machine makes this disappear with no refresh.
 */
export function FirstMachineOnboarding() {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col justify-center gap-6 p-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">{copy.onboarding.title}</h1>
        <p className="text-sm text-muted-foreground">{copy.onboarding.subtitle}</p>
      </div>

      <ol className="space-y-5">
        <li className="space-y-2">
          <p className="text-sm font-medium">
            <span className="mr-2 text-muted-foreground">1</span>
            {copy.onboarding.step1}
          </p>
          <InstallTabs />
        </li>
        <li className="space-y-2">
          <p className="text-sm font-medium">
            <span className="mr-2 text-muted-foreground">2</span>
            {copy.onboarding.step2}
          </p>
          <CopyableCommand command={copy.onboarding.step2Cmd} />
        </li>
        <li className="space-y-1">
          <p className="text-sm font-medium">
            <span className="mr-2 text-muted-foreground">3</span>
            {copy.onboarding.step3}
          </p>
          <p className="pl-6 text-sm text-muted-foreground">{copy.onboarding.step3Hint}</p>
        </li>
      </ol>

      <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-4 py-3">
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {copy.onboarding.waiting}
        </p>
      </div>
    </div>
  );
}
