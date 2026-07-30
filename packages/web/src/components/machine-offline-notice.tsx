"use client";

import { CloudOff } from "lucide-react";
import type { MachineOnlineState } from "@/lib/use-machine-online";

/**
 * The one shared "this machine can't be reached right now" strip every
 * machine-RPC panel renders (Changes, All Files, Checks, Run, Preview, new
 * workspace). Deliberately a slim inline strip, NOT a full-screen or
 * blocking overlay: everything already fetched stays readable and
 * scrollable underneath, and everything sourced from the synced caches (the
 * transcript, the session list) is unaffected by a machine being offline at
 * all.
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
      <span>{state.reason}</span>
    </div>
  );
}
