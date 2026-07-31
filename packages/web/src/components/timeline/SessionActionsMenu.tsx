"use client";

import type { SessionRow } from "@falcon/wire";
import { Archive, CircleStop, MoreHorizontal, Pencil, Pin, RotateCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSessionControl } from "@/features/session-control";
import { ArchiveSessionRunner } from "@/features/session-list/components/archive-session-runner";
import { RenameSessionDialog } from "@/features/session-list/components/rename-session-dialog";
import { RestartSessionDialog } from "@/features/session-list/components/restart-session-dialog";
import { looksLikeWorktreePath } from "@/features/session-list/worktree-path";
import { isRestartEnabled, restartDisabledReason } from "@/lib/use-restart-session";
import {
  useArchiveSessionMutation,
  useDeleteSessionMutation,
  useRestoreSessionMutation,
} from "@/lib/use-session-lifecycle";
import { useSessionMetadataPatchMutation } from "@/lib/use-session-metadata-write";
import {
  initialStopSessionDialogState,
  resetStopSessionDialogState,
  type StopSessionDialogState,
  toStopError,
  toStopping,
} from "./stop-session-state";

/**
 * The session header's single actions menu (⋯) — archive, delete, and
 * end-session consolidated into one dropdown, replacing the old always-
 * visible button row (`SessionHeaderActions`) plus ControlBar's separate
 * "End session" dialog. Both mutations navigate back to Home on success,
 * same as before: delete makes staying impossible, archive leaves no reason
 * to stay. End-session keeps its confirm dialog + `stop-session-state.ts`
 * state machine (it's destructive and irreversible from the web — the CLI
 * process exits), and is unavailable once the session row says the process
 * is already gone (`disabled`).
 */
export function SessionActionsMenu({
  sessionId,
  title,
  status,
  machineId,
  machineOnline,
  workspaceId,
  disabled = false,
}: {
  sessionId: string;
  /** Decrypted session title (`useSessionTitle`), for the Rename dialog's
   * prefill — this menu has no other source of it. */
  title: string;
  /** The session row's own lifecycle status — swaps Archive for Restore
   * once a row has already been marked done (docs/features/
   * session-lifecycle-actions.md Phase 5). */
  status: SessionRow["status"];
  /** The session's owning machine id, and whether it's currently online —
   * Restart's enable condition (Phase 6). `null`/`false` when not yet known
   * or there's no owning machine. */
  machineId: string | null;
  machineOnline: boolean;
  /** This session's `workspaceId` — gates Archive's worktree cleanup the
   * same way `SessionCardActions`' `canOfferRemoveWorktree` does: only a
   * Falcon-managed `.worktrees/<branch>` directory gets the "remove the
   * worktree first" treatment. `null` mirrors `SessionRow.workspaceId`'s own
   * nullability. */
  workspaceId: string | null;
  disabled?: boolean;
}) {
  const router = useRouter();
  const { actions } = useSessionControl();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [archiveRunnerOpen, setArchiveRunnerOpen] = useState(false);
  const [stopState, setStopState] = useState<StopSessionDialogState>(initialStopSessionDialogState);
  const archiveMutation = useArchiveSessionMutation();
  const restoreMutation = useRestoreSessionMutation();
  const deleteMutation = useDeleteSessionMutation();
  const pinMutation = useSessionMetadataPatchMutation(sessionId);
  const archived = status === "archived";
  const restartEnabled = isRestartEnabled({ machineId, machineOnline, status });
  const restartReason = restartDisabledReason({ machineId, machineOnline, status });
  const canRemoveWorktree = machineId !== null && looksLikeWorktreePath(workspaceId);

  function handleStopOpenChange(open: boolean) {
    if (!open) setStopState(resetStopSessionDialogState());
    setStopOpen(open);
  }

  function handleConfirmStop() {
    setStopState(toStopping());
    actions.stopSession().then(
      () => setStopOpen(false),
      (error) => setStopState(toStopError(error)),
    );
  }

  function handleArchiveSelect() {
    if (canRemoveWorktree) {
      setArchiveRunnerOpen(true);
      return;
    }
    archiveMutation.mutate(sessionId, { onSuccess: () => router.push("/dashboard/") });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="icon-sm" variant="outline" aria-label="Session actions">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
            <Pencil className="size-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pinMutation.isPending}
            onSelect={() =>
              pinMutation.mutate((current) => ({ ...current, pinned: !(current.pinned === true) }))
            }
          >
            <Pin className="size-4" />
            Pin / Unpin
          </DropdownMenuItem>
          {archived ? (
            <DropdownMenuItem
              disabled={restoreMutation.isPending}
              onSelect={() => restoreMutation.mutate(sessionId)}
            >
              <Archive className="size-4" />
              Restore
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={archiveMutation.isPending || archiveRunnerOpen}
              onSelect={handleArchiveSelect}
            >
              <Archive className="size-4" />
              Archive
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={disabled} onSelect={() => setStopOpen(true)}>
            <CircleStop className="size-4" />
            End session
          </DropdownMenuItem>
          {!archived && (
            <DropdownMenuItem
              disabled={!restartEnabled}
              title={restartReason ?? undefined}
              onSelect={() => setRestartOpen(true)}
            >
              <RotateCw className="size-4" />
              Restart
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameSessionDialog
        sessionId={sessionId}
        currentTitle={title}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />

      {machineId !== null && (
        <RestartSessionDialog
          machineId={machineId}
          sessionId={sessionId}
          machineName={null}
          open={restartOpen}
          onOpenChange={setRestartOpen}
        />
      )}

      {archiveRunnerOpen && machineId !== null && workspaceId !== null && (
        <ArchiveSessionRunner
          sessionId={sessionId}
          machineId={machineId}
          workspaceId={workspaceId}
          title={title}
          onArchived={() => router.push("/dashboard/")}
          onClose={() => setArchiveRunnerOpen(false)}
        />
      )}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this session?</DialogTitle>
            <DialogDescription>
              Permanently deletes this session and its transcript. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteMutation.isError && (
            <p className="text-sm text-destructive">
              {deleteMutation.error instanceof Error
                ? deleteMutation.error.message
                : "Could not delete the session."}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleteMutation.isPending}
              onClick={() => setDeleteOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() =>
                deleteMutation.mutate(sessionId, { onSuccess: () => router.push("/dashboard/") })
              }
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={stopOpen} onOpenChange={handleStopOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>End this session?</DialogTitle>
            <DialogDescription>
              Ends the CLI process on the machine. The terminal user will see Claude exit.
            </DialogDescription>
          </DialogHeader>
          {stopState.phase === "error" && (
            <p className="text-sm text-destructive">{stopState.message}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={stopState.phase === "stopping"}
              onClick={() => handleStopOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={stopState.phase === "stopping"}
              onClick={handleConfirmStop}
            >
              {stopState.phase === "stopping" ? "Ending…" : "End session"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
