"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRestartSession } from "@/lib/use-restart-session";

/**
 * Restart's confirm dialog (docs/features/session-lifecycle-actions.md
 * Phase 6) — shared between `SessionCardActions` and the timeline header's
 * `SessionActionsMenu`, same "one dialog component, two call sites" shape
 * as `RenameSessionDialog`. Copy states the real semantic
 * (`daemon/resumeSession.ts` kills any running process for this session and
 * relaunches it) rather than implying a gentler no-op restart.
 *
 * The crypto/RPC machinery (`useRestartSession`, which owns a
 * `useMachineCrypto` worker) only mounts while `open` — lazily rendered
 * here, not hoisted to the parent menu — so a list of dozens of session
 * cards never spins up one machine-crypto worker per row (same
 * "Worker-per-card cost" discipline Phase 4's Stop dialog uses).
 */
export function RestartSessionDialog({
  machineId,
  sessionId,
  machineName,
  open,
  onOpenChange,
}: {
  machineId: string;
  sessionId: string;
  /** Decrypted machine name, for the confirm copy — `null` falls back to
   * generic phrasing rather than showing a raw machine id. */
  machineName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restart this session?</DialogTitle>
          <DialogDescription>
            Restart kills any running process for this session and relaunches it
            {machineName ? ` on ${machineName}.` : " on its machine."}
          </DialogDescription>
        </DialogHeader>
        {/* Lazily mounted: only exists while this dialog is open. */}
        {open && (
          <RestartConfirmBody
            machineId={machineId}
            sessionId={sessionId}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RestartConfirmBody({
  machineId,
  sessionId,
  onDone,
}: {
  machineId: string;
  sessionId: string;
  onDone: () => void;
}) {
  const { pending, restart } = useRestartSession(machineId, sessionId);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);

  function handleConfirm() {
    setError(null);
    setInFlight(true);
    restart().then(
      () => onDone(),
      (err) => {
        setInFlight(false);
        // Surfaced verbatim — the daemon's handler-error box carries the
        // honest reason (e.g. "session not in the durable registry"), and
        // resumeSession only covers daemon-persisted sessions, so pretending
        // Restart is universal would be dishonest.
        setError(err instanceof Error ? err.message : "Could not restart the session.");
      },
    );
  }

  return (
    <>
      {pending && <p className="text-sm text-muted-foreground">Machine key unwrapping…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={inFlight} onClick={onDone}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={pending || inFlight} onClick={handleConfirm}>
          {inFlight ? "Restarting…" : "Restart"}
        </Button>
      </DialogFooter>
    </>
  );
}
