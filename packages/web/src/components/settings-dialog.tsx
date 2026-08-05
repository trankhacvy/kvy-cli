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
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  type SettingsSectionMeta,
} from "@/features/settings";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

/** Temporary production-only menu cut: these sections ship in dev builds
 * but are hidden from the dialog menu in production until they're ready.
 * Remove the filter once they land. */
const SECTIONS_HIDDEN_IN_PRODUCTION: SettingsSectionId[] = [
  "providers",
  "notifications",
  "devices",
  "support",
];

function getVisibleSections(): SettingsSectionMeta[] {
  if (process.env.NODE_ENV === "production") {
    return SETTINGS_SECTIONS.filter(
      (section) => !SECTIONS_HIDDEN_IN_PRODUCTION.includes(section.id),
    );
  }
  return SETTINGS_SECTIONS;
}

function findSection(id: SettingsSectionId | null) {
  return SETTINGS_SECTIONS.find((section) => section.id === id);
}

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
  const sections = getVisibleSections();
  const active = findSection(activeId) ?? sections[0];

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
              {sections.map((section) => (
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
  const sections = getVisibleSections();

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
              {sections.map((section) => (
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
 * Controlled — the trigger lives inside a dropdown menu, so open state has
 * to sit above both. `activeId` is shared across both renderings; `null`
 * (the mobile root list) falls back to the first section on desktop.
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
      activeId={activeId ?? getVisibleSections()[0]?.id ?? "agent"}
      onSelect={setActiveId}
    />
  );
}
