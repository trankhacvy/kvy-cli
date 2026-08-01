"use client";

import { ChevronRight, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SessionListMachine, WorkspaceGroup } from "@/features/session-list";
import { NewSessionTrigger } from "@/features/session-list/components/new-session-panel";
import { useWorkspaceNavGroups } from "@/features/session-list/use-workspace-nav";
import { WorkspaceSettingsDialog } from "@/features/workspace-settings";
import { useDebouncedOrder } from "@/hooks/use-debounced-order";
import { getExpandedWorkspaces, setWorkspaceExpanded } from "./workspace-nav-expand-state";

const SESSIONS_PER_WORKSPACE = 5;
// Longer than Home's — this is a persistent nav element, so stability matters
// more here than freshness of order (docs/workspace-nav-redesign-plan.md
// decision #6).
const REORDER_DEBOUNCE_MS = 4000;
const SKELETON_ROW_IDS = ["skeleton-1", "skeleton-2", "skeleton-3"];

function workspaceKey(group: WorkspaceGroup): string {
  return group.workspace.id;
}

/** The machine to target for this workspace's daemon RPCs (settings dialog,
 * new-session picker) — the most recent session's machine, if any. A
 * workspace with no sessions yet (or whose sessions are all unmanaged/
 * machine-less) has none, which the settings dialog treats as "no machine
 * associated yet" rather than erroring. */
function resolveGroupMachineId(group: WorkspaceGroup): string | null {
  return group.sessions.find((session) => session.machineId !== null)?.machineId ?? null;
}

export function WorkspaceNav() {
  const { groups, machinesById, isLoading } = useWorkspaceNavGroups();
  const [paused, setPaused] = useState(false);
  const stableGroups = useDebouncedOrder(groups, workspaceKey, REORDER_DEBOUNCE_MS, paused);

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Workspaces</SidebarGroupLabel>
      <SidebarGroupContent
        className="max-h-80 overflow-y-auto"
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => setPaused(false)}
      >
        {isLoading && stableGroups.length === 0 ? (
          <SidebarMenu>
            {SKELETON_ROW_IDS.map((id) => (
              <SidebarMenuItem key={id}>
                <SidebarMenuSkeleton />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        ) : stableGroups.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            No workspaces yet. Run <code className="rounded bg-muted px-1 py-0.5">kvy</code> from a
            project to see it here.
          </p>
        ) : (
          <SidebarMenu>
            {stableGroups.map((group) => (
              <WorkspaceNavItem
                key={group.workspace.id}
                group={group}
                machinesById={machinesById}
              />
            ))}
          </SidebarMenu>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function WorkspaceNavItem({
  group,
  machinesById,
}: {
  group: WorkspaceGroup;
  machinesById: Map<string, SessionListMachine>;
}) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(() => getExpandedWorkspaces().has(group.workspace.id));
  const [showAll, setShowAll] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const machineId = resolveGroupMachineId(group);
  const machine = machineId ? (machinesById.get(machineId) ?? null) : null;

  function handleOpenChange(next: boolean) {
    setExpanded(next);
    setWorkspaceExpanded(group.workspace.id, next);
  }

  const hasSessions = group.sessions.length > 0;
  const visible = showAll ? group.sessions : group.sessions.slice(0, SESSIONS_PER_WORKSPACE);
  const hasMore = group.sessions.length > SESSIONS_PER_WORKSPACE;

  return (
    <Collapsible open={expanded} onOpenChange={handleOpenChange} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton disabled={!hasSessions} className="pr-16">
            {hasSessions ? (
              <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90" />
            ) : (
              <span className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{group.workspace.name}</span>
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100">
          <WorkspaceSettingsButton
            workspaceName={group.workspace.name}
            onClick={() => setSettingsOpen(true)}
          />
          <NewSessionTrigger group={group} machinesById={machinesById} />
        </div>
        <WorkspaceSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          workspacePath={group.workspace.id}
          workspaceName={group.workspace.name}
          machineId={machineId}
          machine={machine}
        />
        {hasSessions && (
          <CollapsibleContent>
            <SidebarMenuSub>
              {visible.map((session) => (
                <SidebarMenuSubItem key={session.id}>
                  <SidebarMenuSubButton
                    asChild
                    isActive={pathname === `/dashboard/session/${session.id}/`}
                  >
                    <Link href={`/dashboard/session/${session.id}/`}>
                      <span className="truncate">{session.title ?? "Untitled session"}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))}
              {hasMore && !showAll && (
                <SidebarMenuSubItem>
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Show {group.sessions.length - SESSIONS_PER_WORKSPACE} more
                  </button>
                </SidebarMenuSubItem>
              )}
            </SidebarMenuSub>
          </CollapsibleContent>
        )}
      </SidebarMenuItem>
    </Collapsible>
  );
}

/** Opens `WorkspaceSettingsDialog` for this workspace (General/Git config). */
function WorkspaceSettingsButton({
  workspaceName,
  onClick,
}: {
  workspaceName: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={`${workspaceName} settings`}
          onClick={onClick}
        >
          <Settings className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Workspace settings</TooltipContent>
    </Tooltip>
  );
}
