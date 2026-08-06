"use client";

import type { SessionRow } from "@kvy/wire";
import { Archive, MoreHorizontal, Pencil, Pin } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArchiveSessionDialog } from "@/features/session-list/components/archive-session-dialog";
import { RenameSessionDialog } from "@/features/session-list/components/rename-session-dialog";
import { useSessionMetadataPatchMutation } from "@/lib/use-session-metadata-write";

/**
 * The session header's single actions menu (⋯) — Rename, Pin/Unpin, and
 * Archive, structurally identical to the Home card's `SessionCardActions`
 * (same `ArchiveSessionDialog`, same "single lifecycle action" model —
 * no separate Stop/Restart/Delete/Restore). Archive navigates back to Home
 * on success, since staying on an archived session's own screen mid-archive
 * would be disorienting.
 */
export function SessionActionsMenu({
  sessionId,
  title,
  status,
  machineId,
  workspacePath,
}: {
  sessionId: string;
  /** Decrypted session title (`useSessionTitle`), for the Rename dialog's
   * prefill — this menu has no other source of it. */
  title: string;
  status: SessionRow["status"];
  machineId: string | null;
  /** This session's real working-directory path, decrypted from
   * `session.metadata` (never `session.workspaceId`, which is an opaque id) —
   * `null` (or a plain repo-root path) means Archive has no worktree to
   * clean up. */
  workspacePath: string | null;
}) {
  const router = useRouter();
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const pinMutation = useSessionMetadataPatchMutation(sessionId);
  const archived = status === "archived";

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
          {!archived && (
            <DropdownMenuItem onSelect={() => setArchiveOpen(true)}>
              <Archive className="size-4" />
              Archive
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameSessionDialog
        sessionId={sessionId}
        currentTitle={title}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />

      <ArchiveSessionDialog
        sessionId={sessionId}
        title={title}
        status={status}
        machineId={machineId}
        workspaceId={workspacePath}
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        onArchived={() => router.push("/dashboard/")}
      />
    </>
  );
}
