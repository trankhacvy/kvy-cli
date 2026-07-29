"use client";

import { ChevronLeftIcon, ChevronRightIcon, GitBranchIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { SessionListMachine } from "@/features/session-list";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { GeneralSection } from "./GeneralSection.js";
import { WorkspaceGitSection } from "./WorkspaceGitSection.js";

type SectionId = "general" | "git";

interface Section {
  id: SectionId;
  label: string;
  icon: typeof SettingsIcon;
}

const SECTIONS: Section[] = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "git", label: "Git", icon: GitBranchIcon },
];

interface WorkspaceSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceName: string;
  machineId: string | null;
  machine: SessionListMachine | null;
}

function SectionContent({
  activeId,
  workspacePath,
  machineId,
  machine,
}: {
  activeId: SectionId;
  workspacePath: string;
  machineId: string | null;
  machine: SessionListMachine | null;
}) {
  if (activeId === "general") {
    return <GeneralSection workspacePath={workspacePath} machine={machine} />;
  }
  return <WorkspaceGitSection workspacePath={workspacePath} machineId={machineId} />;
}

/** Desktop rendering: left section nav + right content pane — structural
 * clone of `components/settings-dialog.tsx`'s `SettingsDialogDesktop`. */
function WorkspaceSettingsDialogDesktop({
  open,
  onOpenChange,
  workspaceName,
  workspacePath,
  machineId,
  machine,
  activeId,
  onSelect,
}: WorkspaceSettingsDialogProps & { activeId: SectionId; onSelect: (id: SectionId) => void }) {
  const active = SECTIONS.find((section) => section.id === activeId) ?? SECTIONS[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-3xl" showCloseButton>
        <DialogHeader className="sr-only">
          <DialogTitle>{workspaceName} settings</DialogTitle>
          <DialogDescription>Workspace settings sections</DialogDescription>
        </DialogHeader>
        <div className="flex h-[28rem] min-w-0">
          <div className="flex w-52 shrink-0 flex-col border-r border-border">
            <div className="truncate border-b border-border px-3 py-3 text-sm font-medium">
              {workspaceName}
            </div>
            <nav aria-label="Workspace settings sections" className="overflow-y-auto p-2">
              <ul className="flex flex-col gap-0.5">
                {SECTIONS.map((section) => (
                  <li key={section.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(section.id)}
                      aria-current={section.id === active?.id ? "page" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                        section.id === active?.id && "bg-accent text-accent-foreground",
                      )}
                    >
                      <section.icon aria-hidden="true" className="size-4" />
                      {section.label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            {active && (
              <>
                <h2 className="mb-4 text-lg font-semibold tracking-tight">{active.label}</h2>
                <SectionContent
                  activeId={active.id}
                  workspacePath={workspacePath}
                  machineId={machineId}
                  machine={machine}
                />
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Mobile rendering: bottom sheet, iOS-Settings-style drill-in — structural
 * clone of `components/settings-dialog.tsx`'s `SettingsSheetMobile`. */
function WorkspaceSettingsSheetMobile({
  open,
  onOpenChange,
  workspaceName,
  workspacePath,
  machineId,
  machine,
  activeId,
  onSelect,
}: WorkspaceSettingsDialogProps & {
  activeId: SectionId | null;
  onSelect: (id: SectionId | null) => void;
}) {
  const active = SECTIONS.find((section) => section.id === activeId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85svh] min-h-[50svh] gap-0">
        {active ? (
          <>
            <SheetHeader className="flex-row items-center gap-1 space-y-0 border-b border-border px-2 py-3">
              <button
                type="button"
                onClick={() => onSelect(null)}
                aria-label="Back to workspace settings"
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <ChevronLeftIcon aria-hidden="true" className="size-4" />
                Back
              </button>
              <SheetTitle className="flex-1 pr-12 text-center">{active.label}</SheetTitle>
              <SheetDescription className="sr-only">{active.label} settings</SheetDescription>
            </SheetHeader>
            <div className="overflow-y-auto p-4">
              <SectionContent
                activeId={active.id}
                workspacePath={workspacePath}
                machineId={machineId}
                machine={machine}
              />
            </div>
          </>
        ) : (
          <>
            <SheetHeader className="border-b border-border">
              <SheetTitle className="truncate">{workspaceName}</SheetTitle>
              <SheetDescription className="sr-only">Workspace settings sections</SheetDescription>
            </SheetHeader>
            <ul className="flex flex-col gap-0.5 overflow-y-auto p-2">
              {SECTIONS.map((section) => (
                <li key={section.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(section.id)}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  >
                    <section.icon aria-hidden="true" className="size-4 text-muted-foreground" />
                    <span className="flex-1">{section.label}</span>
                    <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Per-workspace settings dialog, opened from `WorkspaceSettingsButton`
 * (`components/workspace-nav.tsx`) — structural clone of
 * `components/settings-dialog.tsx`'s account-level `SettingsDialog`: a wide
 * dialog on desktop, a drill-in bottom sheet on mobile. Scoped to General
 * (path/machine) and Git (base branch/remote) for now — Scripts/Sandbox are
 * explicitly out of scope (see the Git tab write path's own doc comments for
 * why script content stays local-only).
 */
export function WorkspaceSettingsDialog(props: WorkspaceSettingsDialogProps) {
  const isMobile = useIsMobile();
  const [activeId, setActiveId] = useState<SectionId | null>(null);

  function handleOpenChange(next: boolean) {
    if (!next) setActiveId(null);
    props.onOpenChange(next);
  }

  if (isMobile) {
    return (
      <WorkspaceSettingsSheetMobile
        {...props}
        onOpenChange={handleOpenChange}
        activeId={activeId}
        onSelect={setActiveId}
      />
    );
  }
  return (
    <WorkspaceSettingsDialogDesktop
      {...props}
      onOpenChange={handleOpenChange}
      activeId={activeId ?? "general"}
      onSelect={setActiveId}
    />
  );
}
