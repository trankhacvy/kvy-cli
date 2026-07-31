"use client";

import type { SessionRow } from "@falcon/wire";
import { Archive, MoreHorizontal, Pencil, Pin, PinOff } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSessionMetadataPatchMutation } from "@/lib/use-session-metadata-write";
import { ArchiveSessionDialog } from "./archive-session-dialog";
import { RenameSessionDialog } from "./rename-session-dialog";
import { buildPinTogglePatch } from "./session-card-actions-logic";

/**
 * Lifecycle actions for one Home-screen `SessionCard`, consolidated into
 * one '···' `DropdownMenu`: Rename, Pin/Unpin, and Archive — the single
 * lifecycle action (conductor.build's model: no separate Stop/Restart/
 * Remove-worktree/Delete/Restore; Archive stops the process, cleans up the
 * worktree, and leaves the transcript read-only-viewable). Structurally
 * identical to the timeline header's `SessionActionsMenu`.
 *
 * Archived rows (only ever rendered on the Completed Chats screen — Home
 * filters archived sessions out) just drop the Archive item; there's
 * nothing further to do here for now.
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
  workspaceId,
}: {
  sessionId: string;
  title: string;
  pinned: boolean;
  status: SessionRow["status"];
  /** `null` when this session has no owning machine at all (e.g. a
   * terminal-only session that was never remote-spawned). */
  machineId: string | null;
  /** This session's `workspaceId` — `null` (or a plain repo-root path)
   * means Archive has no worktree to clean up. */
  workspaceId: string | null;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const pinMutation = useSessionMetadataPatchMutation(sessionId);
  const archived = status === "archived";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Session actions">
            <MoreHorizontal />
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
        workspaceId={workspaceId}
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
      />
    </>
  );
}
