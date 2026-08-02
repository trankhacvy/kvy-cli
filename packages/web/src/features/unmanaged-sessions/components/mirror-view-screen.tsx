"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLiveUnmanagedSessions } from "../live-source";
import { useMockUnmanagedActions } from "../mock-source";
import type { UseUnmanagedActions, UseUnmanagedSessionsSnapshot } from "../types";
import { useMirrorTranscript } from "../use-mirror-transcript";
import { TakeOverDialog } from "./take-over-dialog";

/**
 * "unmanaged row visible on phone (live read-only mirror via chunked RPC)";
 * a mirror of someone else's terminal session, not a control surface, so it
 * carries no `Composer`/mode controls, only a `TakeOverDialog` entry point.
 *
 * `useSnapshot` defaults to the real `useLiveUnmanagedSessions` (the sync
 * engine's unmanaged-sessions snapshot). `useActions` still defaults to the
 * mock — a live per-machine RPC/crypto client for take-over/mirroring isn't
 * wired in yet (same not-yet-wired caveat as `UnmanagedSection`).
 */
export function MirrorViewScreen({
  id,
  useSnapshot = useLiveUnmanagedSessions,
  useActions = useMockUnmanagedActions,
}: {
  id: string;
  useSnapshot?: UseUnmanagedSessionsSnapshot;
  useActions?: UseUnmanagedActions;
}) {
  const snapshot = useSnapshot();
  const session = snapshot.sessions.find((s) => s.id === id) ?? null;
  const machine = session
    ? (snapshot.machines.find((m) => m.id === session.machineId) ?? null)
    : null;
  const [dialogOpen, setDialogOpen] = useState(false);

  // `useActions` is a hook; called unconditionally here (before the
  // not-found early return below) so its call site stays stable across
  // renders regardless of whether `session` resolves.
  const actions = useActions(session?.machineId ?? "");
  const { lines, isLoading, error } = useMirrorTranscript(actions, session?.providerRef ?? "");

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-col items-center gap-3 p-8 text-center">
        <p className="text-sm font-medium">Unmanaged session not found</p>
        <p className="text-sm text-muted-foreground">
          It may have been adopted or its transcript is no longer indexed.
        </p>
      </main>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{session.title}</p>
          <p className="text-xs text-muted-foreground">
            {session.running ? "Running" : "Idle"} on {machine?.name ?? "unknown machine"} ·
            read-only mirror
          </p>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          Take over
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading && lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading transcript…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">This transcript is empty so far.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: transcript lines have no stable id and are only ever appended/replaced wholesale on each poll, never reordered
              <div key={i} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {line.kind === "user" ? "User" : line.kind === "agent" ? "Assistant" : "Other"}
                </span>
                <p
                  className={cn(
                    "whitespace-pre-wrap text-sm",
                    line.kind === "raw" && "font-mono text-xs text-muted-foreground",
                  )}
                >
                  {line.text}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <TakeOverDialog
        session={session}
        actions={actions}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}
