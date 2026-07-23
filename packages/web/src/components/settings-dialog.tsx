"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
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
import { SETTINGS_SECTIONS, type SettingsSectionId } from "@/features/settings";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

function findSection(id: SettingsSectionId | null) {
  return SETTINGS_SECTIONS.find((section) => section.id === id);
}

/** Desktop rendering: left section nav + right content pane showing the
 * active section's real settings UI. */
function SettingsDialogDesktop({
  open,
  onOpenChange,
  activeId,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeId: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
}) {
  const active = findSection(activeId) ?? SETTINGS_SECTIONS[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-4xl" showCloseButton>
        <DialogHeader className="sr-only">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Settings sections</DialogDescription>
        </DialogHeader>
        <div className="flex h-[32rem]">
          <nav
            aria-label="Settings sections"
            className="w-44 shrink-0 overflow-y-auto border-r border-border p-2"
          >
            <ul className="flex flex-col gap-0.5">
              {SETTINGS_SECTIONS.map((section) => (
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
          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            {active && (
              <>
                <h2 className="mb-4 text-lg font-semibold tracking-tight">{active.label}</h2>
                <active.Content />
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Mobile rendering: bottom sheet. The root view is the section list;
 * tapping a section pushes its settings UI inside the same sheet (back
 * button returns to the list) — an iOS-Settings-style drill-in, not a route
 * navigation. */
function SettingsSheetMobile({
  open,
  onOpenChange,
  activeId,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` = root list view. */
  activeId: SettingsSectionId | null;
  onSelect: (id: SettingsSectionId | null) => void;
}) {
  const active = findSection(activeId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85svh] min-h-[50svh] gap-0">
        {active ? (
          <>
            <SheetHeader className="flex-row items-center gap-1 space-y-0 border-b border-border px-2 py-3">
              <button
                type="button"
                onClick={() => onSelect(null)}
                aria-label="Back to settings"
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <ChevronLeftIcon aria-hidden="true" className="size-4" />
                Back
              </button>
              <SheetTitle className="flex-1 pr-12 text-center">{active.label}</SheetTitle>
              <SheetDescription className="sr-only">{active.label} settings</SheetDescription>
            </SheetHeader>
            <div className="overflow-y-auto p-4">
              <active.Content />
            </div>
          </>
        ) : (
          <>
            <SheetHeader className="border-b border-border">
              <SheetTitle>Settings</SheetTitle>
              <SheetDescription className="sr-only">Settings sections</SheetDescription>
            </SheetHeader>
            <ul className="flex flex-col gap-0.5 overflow-y-auto p-2">
              {SETTINGS_SECTIONS.map((section) => (
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
 * Settings dialog, opened from the sidebar's account menu (`nav-user.tsx`) —
 * the only home of the settings catalog since the `/settings/*` routes were
 * removed and the sidebar's Settings group went with them. Controlled — the
 * trigger lives inside a dropdown menu, so open state has to sit above both.
 * Renders as a wide dialog on desktop and as a drill-in bottom sheet on
 * mobile (`useIsMobile`, same breakpoint the sidebar itself uses).
 * `activeId` is shared across both renderings; `null` (the mobile root
 * list) falls back to the first section on desktop.
 */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const [activeId, setActiveId] = useState<SettingsSectionId | null>(null);

  function handleOpenChange(next: boolean) {
    if (!next) setActiveId(null);
    onOpenChange(next);
  }

  if (isMobile) {
    return (
      <SettingsSheetMobile
        open={open}
        onOpenChange={handleOpenChange}
        activeId={activeId}
        onSelect={setActiveId}
      />
    );
  }
  return (
    <SettingsDialogDesktop
      open={open}
      onOpenChange={handleOpenChange}
      activeId={activeId ?? SETTINGS_SECTIONS[0]?.id ?? "agent"}
      onSelect={setActiveId}
    />
  );
}
