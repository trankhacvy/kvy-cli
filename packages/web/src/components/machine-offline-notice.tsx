"use client";

import { CloudOff } from "lucide-react";
import { InlineCommandText } from "@/components/inline-command-text";
import type { MachineOnlineState } from "@/lib/use-machine-online";

/**
 * Deliberately a slim inline strip, not a full-screen overlay: everything
 * already fetched stays readable and scrollable underneath.
 *
 * Renders nothing when the machine is online or its state is unknown — see
 * `useMachineOnline`'s doc comment on why "unknown" must never look like
 * "offline".
 */
export function MachineOfflineNotice({ state }: { state: MachineOnlineState }) {
  if (!state.isKnownUnavailable || state.reason === null) return null;
  return (
    <div
      className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <CloudOff className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        <InlineCommandText text={state.reason} />
      </span>
    </div>
  );
}
