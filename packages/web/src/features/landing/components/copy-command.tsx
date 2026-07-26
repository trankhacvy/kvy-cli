"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The landing page's real CTA for a CLI product: a mono command chip that
 * copies itself on click. Sits next to (never replaces) the signup-intent
 * "Get started" button — different intent, so both may appear together.
 */
export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(
    () => () => {
      if (timeout.current) clearTimeout(timeout.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable (permissions / insecure context) — the command
      // text itself stays fully selectable, so the chip degrades gracefully.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy "${command}"`}
      className={cn(
        "group inline-flex h-10 shrink-0 items-center gap-2.5 rounded-md border border-border bg-card px-3.5 font-mono text-sm text-muted-foreground transition-colors select-none hover:border-foreground/25 hover:text-foreground active:translate-y-px",
        className,
      )}
    >
      <span aria-hidden="true" className="text-muted-foreground/60">
        $
      </span>
      {command}
      {copied ? (
        <Check aria-hidden="true" className="size-3.5 text-primary" />
      ) : (
        <Copy
          aria-hidden="true"
          className="size-3.5 opacity-50 transition-opacity group-hover:opacity-100"
        />
      )}
    </button>
  );
}
