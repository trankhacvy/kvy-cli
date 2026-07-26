"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { copy } from "@/lib/copy";

/**
 * The only entry point to the destructive key-rotation flow. A link, never a primary
 * button sitting next to a safe one, and it always states what it erases before the user
 * can reach the rotation screen.
 */
export function StartOverLink() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        className="text-xs text-muted-foreground underline underline-offset-4"
        onClick={() => setOpen(true)}
      >
        {copy.keys.cantReach}
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-destructive/40 p-4 text-left">
      <p className="text-sm font-medium text-destructive">{copy.reset.linkLabel}</p>
      <p className="text-sm text-muted-foreground">{copy.reset.warning}</p>
      <div className="flex gap-2">
        <Button variant="destructive" size="sm" onClick={() => router.push("/reset-keys/")}>
          {copy.reset.confirmCta}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {copy.reset.cancelCta}
        </Button>
      </div>
    </div>
  );
}
