"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** Label shown while the "copied" flash is active vs. the resting state —
 * extracted for the same DOM-free-unit-testability reason as
 * `ThinkingBlock.tsx`'s `thinkingBlockLabel`. */
export function copyButtonLabel(copied: boolean, restLabel: string): string {
  return copied ? "Copied" : restLabel;
}

/**
 * Generic "copy to clipboard" affordance. Takes a `getText` thunk rather
 * than a plain `text` prop so a caller whose content only exists as rendered
 * DOM (`CodeBlock`'s `pre.textContent`, after shiki's per-token `<span>` tree)
 * can defer reading it until the moment of the click, instead of
 * re-serializing that tree itself.
 */
export function CopyButton({
  getText,
  label = "Copy",
  className,
}: {
  getText: () => string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  async function handleClick() {
    const text = getText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard access can fail (denied permission, insecure context) —
      // nothing else to recover here; the button simply never flashes
      // "Copied".
    }
  }

  const displayLabel = copyButtonLabel(copied, label);

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={displayLabel}
      title={displayLabel}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-md border border-border/70 bg-background/80 text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}
