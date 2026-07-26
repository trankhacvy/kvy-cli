"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
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
import {
  type DialogState,
  initialDialogState,
  needsRunningConfirm,
  resetDialogState,
  toChoose,
  toConfirm,
  toError,
  toSuccess,
} from "../take-over-dialog-state";
import type { AdoptMode, UnmanagedActions, UnmanagedSessionItem } from "../types";

/**
 * "Take Over / Fork Instead" dialog (falcon-system-design.md §10.4/§11 UC9,
 * plan.md §16 "3.3 Session adoption (UC9)"): confirms the adoption mode,
 * warns about interrupting a still-running process before a takeover, then
 * calls `adopt.take` (via the injected `actions.take`) and hands the
 * caller a link to the freshly-adopted managed session.
 *
 * "Take Over" (`mode: 'takeover'`) kills the owning `claude` process
 * (SIGTERM ≤5s → SIGKILL, daemon-side) and continues in its place — a
 * mid-turn session loses whatever that turn was doing. "Fork Instead"
 * (`mode: 'fork'`) leaves the original terminal session running untouched
 * and starts a brand-new lineage from the same transcript history (design
 * §7.8: "`mode: 'fork'` skips the kill and copies the transcript to a fresh
 * lineage").
 */
export function TakeOverDialog({
  session,
  actions,
  open,
  onOpenChange,
}: {
  session: UnmanagedSessionItem;
  actions: UnmanagedActions;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, setState] = useState<DialogState>(initialDialogState);

  const mutation = useMutation({
    mutationFn: (mode: AdoptMode) => actions.take(session.providerRef, mode),
  });

  function handleOpenChange(next: boolean) {
    if (!next) setState(resetDialogState()); // reset for the next time this dialog opens
    onOpenChange(next);
  }

  function chooseMode(mode: AdoptMode) {
    if (needsRunningConfirm(mode, session.running)) {
      setState(toConfirm(mode));
      return;
    }
    submit(mode);
  }

  function submit(mode: AdoptMode) {
    mutation.mutate(mode, {
      onSuccess: (outcome) => setState(toSuccess(outcome, mode)),
      onError: (error) => setState(toError(error)),
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        {state.phase === "success" ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {state.mode === "takeover" ? "Session taken over" : "Session forked"}
              </DialogTitle>
              <DialogDescription>
                {state.mode === "takeover"
                  ? "Falcon is now driving this session — the terminal process was stopped."
                  : "A new managed session was started from this transcript. The original terminal session is untouched."}
              </DialogDescription>
            </DialogHeader>
            {state.outcome.warning && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                {state.outcome.warning}
              </p>
            )}
            <DialogFooter>
              <Button asChild>
                <Link href={`/dashboard/session/${state.outcome.sessionId}/`}>Open session</Link>
              </Button>
            </DialogFooter>
          </>
        ) : state.phase === "confirm" ? (
          <>
            <DialogHeader>
              <DialogTitle>This session looks like it&apos;s still running</DialogTitle>
              <DialogDescription>
                Taking over will interrupt the current turn on the terminal — any in-progress tool
                call there is stopped. Fork instead to leave it running and start a separate session
                from the same history.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setState(toChoose())}>
                Back
              </Button>
              <Button variant="destructive" onClick={() => submit("takeover")}>
                Take over anyway
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Adopt &ldquo;{session.title}&rdquo;</DialogTitle>
              <DialogDescription>
                Take over to continue this session from Falcon (stops the terminal process). Fork
                instead to start a new managed session from the same history, leaving the original
                running.
              </DialogDescription>
            </DialogHeader>
            {state.phase === "error" && <p className="text-sm text-destructive">{state.message}</p>}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => chooseMode("fork")}
              >
                Fork instead
              </Button>
              <Button disabled={mutation.isPending} onClick={() => chooseMode("takeover")}>
                {mutation.isPending ? "Taking over…" : "Take over"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
