"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Displays a grouped-Base32 recovery code (design §5.1 "Recovery": masterSecret
 * exportable as grouped Base32) with a copy-to-clipboard affordance. Used both
 * right after signup (`src/app/signin/page.tsx`) and from Settings → Recovery
 * (`features/settings/components/RecoverySection.tsx`, inside the settings
 * dialog) — the export mechanism is identical, only the surrounding copy
 * differs.
 */
export function RecoveryCodeCard({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied (permissions, non-secure context) —
      // the code is still fully visible/selectable on screen, so this is a
      // degraded-but-recoverable failure, not a dead end.
    }
  }

  return (
    <div className="w-full max-w-md rounded-lg border bg-card p-4 text-card-foreground">
      <p
        className="select-all break-all rounded-md bg-muted px-3 py-2 font-mono text-sm tracking-wide"
        data-testid="recovery-code"
      >
        {code}
      </p>
      <Button type="button" variant="outline" size="sm" className="mt-3" onClick={handleCopy}>
        {copied ? "Copied" : "Copy to clipboard"}
      </Button>
    </div>
  );
}
