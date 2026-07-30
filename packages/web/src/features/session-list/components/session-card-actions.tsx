"use client";

import type { SessionRow } from "@falcon/wire";
import {
  Archive,
  CircleStop,
  FolderX,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RotateCw,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import {
  initialStopSessionDialogState,
  resetStopSessionDialogState,
  type StopSessionDialogState,
  toStopError,
  toStopping,
} from "@/components/timeline/stop-session-state";
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
import { useSessionCrypto } from "@/features/session-control/use-session-crypto";
import { isRestartEnabled, restartDisabledReason } from "@/lib/use-restart-session";
import {
  useArchiveSessionMutation,
  useDeleteSessionMutation,
  useRestoreSessionMutation,
} from "@/lib/use-session-lifecycle";
import { useSessionMetadataPatchMutation } from "@/lib/use-session-metadata-write";
import { apiSocket, createSessionRpcClient } from "@/sync";
import { RemoveWorktreeDialog } from "./remove-worktree-dialog";
import { RenameSessionDialog } from "./rename-session-dialog";
import { RestartSessionDialog } from "./restart-session-dialog";
import {
  buildPinTogglePatch,
  canOfferRemoveWorktree,
  isSessionStoppable,
} from "./session-card-actions-logic";

/**
 * Lifecycle actions for one Home-screen `SessionCard`
 * (docs/features/session-lifecycle-actions.md) — Rename, Pin/Unpin, Stop,
 * Restart (disabled here; wired in Phase 6), Mark done, and Delete,
 * consolidated into one '···' `DropdownMenu`, structurally cloned from the
 * timeline header's `SessionActionsMenu`. Replaces the previous
 * always-visible two-icon-button row (Archive, Delete) plan-v2.md W4.2
 * shipped first.
 *
 * For an already-archived row (only ever rendered on the Completed Chats
 * screen — Home filters archived sessions out, Phase 5) the menu instead
 * shows Restore, Rename, Pin/Unpin, and Delete: Stop/Restart/Mark done make
 * no sense against a session that's already been marked done.
 *
 * Rendered as a sibling of the card's own `Link` (see `SessionCard`'s own
 * comment on why) — nothing here nests inside that anchor.
 */
export function SessionCardActions({
  sessionId,
  title,
  pinned,
  status,
  machineId,
  machineOnline,
  machineName,
  workspaceId,
}: {
  sessionId: string;
  title: string;
  pinned: boolean;
  status: SessionRow["status"];
  /** `null` when this session has no owning machine at all (e.g. a
   * terminal-only session that was never remote-spawned). */
  machineId: string | null;
  machineOnline: boolean;
  machineName: string | null;
  /** This session's `workspaceId` — backs "Remove worktree" (Phase C):
   * only offered when it looks like a Falcon-managed `.worktrees/<branch>`
   * directory (`looksLikeWorktreePath`), never for an ordinary repo-root
   * session. `null` mirrors `SessionListSession.workspaceId`'s own
   * nullability. */
  workspaceId: string | null;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [removeWorktreeOpen, setRemoveWorktreeOpen] = useState(false);
  const [stopState, setStopState] = useState<StopSessionDialogState>(initialStopSessionDialogState);
  const archiveMutation = useArchiveSessionMutation();
  const restoreMutation = useRestoreSessionMutation();
  const deleteMutation = useDeleteSessionMutation();
  const pinMutation = useSessionMetadataPatchMutation(sessionId);
  const archived = status === "archived";
  const stoppable = isSessionStoppable(status);
  const restartEnabled = isRestartEnabled({ machineId, machineOnline, status });
  const restartReason = restartDisabledReason({ machineId, machineOnline, status });
  const canRemoveWorktree = canOfferRemoveWorktree(machineId, workspaceId);

  function handleStopOpenChange(open: boolean) {
    if (!open) setStopState(resetStopSessionDialogState());
    setStopOpen(open);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Session actions"
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
            <Pencil className="size-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pinMutation.isPending}
            onSelect={() => pinMutation.mutate(buildPinTogglePatch(pinned))}
          >
            {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            {pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          {!archived && (
            <DropdownMenuItem
              disabled={!stoppable}
              title={stoppable ? undefined : "This session's process has already ended"}
              onSelect={() => setStopOpen(true)}
            >
              <CircleStop className="size-4" />
              Stop
            </DropdownMenuItem>
          )}
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
          {canRemoveWorktree && (
            <DropdownMenuItem onSelect={() => setRemoveWorktreeOpen(true)}>
              <FolderX className="size-4" />
              Remove worktree
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
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
              disabled={archiveMutation.isPending}
              onSelect={() => archiveMutation.mutate(sessionId)}
            >
              <Archive className="size-4" />
              Mark done
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
          machineName={machineName}
          open={restartOpen}
          onOpenChange={setRestartOpen}
        />
      )}

      {canRemoveWorktree && machineId !== null && workspaceId !== null && (
        <RemoveWorktreeDialog
          machineId={machineId}
          worktree={workspaceId}
          sessionTitle={title}
          open={removeWorktreeOpen}
          onOpenChange={setRemoveWorktreeOpen}
        />
      )}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{title}"?</DialogTitle>
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
                deleteMutation.mutate(sessionId, { onSuccess: () => setDeleteOpen(false) })
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
            <DialogTitle>Stop "{title}"?</DialogTitle>
            <DialogDescription>
              Ends the CLI process on its machine. The terminal user will see Claude exit.
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
            {/* Lazily mounted: the crypto worker + session-RPC client only
             * spin up while this dialog is actually open, so rendering a
             * list of dozens of cards never spawns one worker per row
             * (Phase 4's "Worker-per-card cost" risk). */}
            {stopOpen && (
              <CardStopConfirmButton
                sessionId={sessionId}
                stopping={stopState.phase === "stopping"}
                onStopping={() => setStopState(toStopping())}
                onSuccess={() => setStopOpen(false)}
                onError={(err) => setStopState(toStopError(err))}
              />
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The "Stop" confirm button's own crypto/RPC wiring, split into a child so
 * `useSessionCrypto`'s worker only exists while the dialog housing this
 * component is mounted — reuses the exact `stop` session RPC the timeline's
 * "End session" already calls (`sync/sessionRpc.ts`). */
function CardStopConfirmButton({
  sessionId,
  stopping,
  onStopping,
  onSuccess,
  onError,
}: {
  sessionId: string;
  stopping: boolean;
  onStopping: () => void;
  onSuccess: () => void;
  onError: (error: unknown) => void;
}) {
  const crypto = useSessionCrypto(sessionId);

  function handleConfirm() {
    if (!crypto) {
      onError(new Error("Crypto bridge isn't ready yet. Try again in a moment."));
      return;
    }
    onStopping();
    createSessionRpcClient({ socket: apiSocket, crypto, sessionId })
      .call("stop", {})
      .then(onSuccess, onError);
  }

  return (
    <Button variant="destructive" disabled={stopping || !crypto} onClick={handleConfirm}>
      {stopping ? "Stopping…" : "Stop"}
    </Button>
  );
}
