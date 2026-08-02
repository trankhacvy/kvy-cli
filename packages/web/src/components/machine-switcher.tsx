"use client";

import { CheckIcon, ChevronsUpDownIcon, MonitorIcon } from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { MACHINE_STATUS_META, useLiveSessionListSnapshot } from "@/features/session-list";
import { cn } from "@/lib/utils";
import {
  getSelectedMachineId,
  resolveSelectedMachine,
  setSelectedMachineId,
} from "./machine-switcher-state";

function MachineLabel({ name }: { name: string | null }) {
  if (name === null) return <Skeleton className="h-3 w-16" />;
  return <>{name}</>;
}

export function MachineSwitcher() {
  const { machines, isLoading } = useLiveSessionListSnapshot();
  const [selectedId, setSelectedId] = useState<string | null>(() => getSelectedMachineId());

  function handleSelect(id: string): void {
    setSelectedId(id);
    setSelectedMachineId(id);
  }

  if (machines.length === 0) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" disabled className="opacity-60">
            <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              <MonitorIcon className="size-4" />
            </div>
            <span className="truncate text-sm group-data-[collapsible=icon]:hidden">
              {isLoading ? "Loading machines…" : "No machines yet"}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const selected = resolveSelectedMachine(machines, selectedId);
  const meta = selected ? MACHINE_STATUS_META[selected.status] : null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={selected?.name ?? "Machine"}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="relative flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <MonitorIcon className="size-4" />
                {meta && (
                  <span
                    className={cn(
                      "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-sidebar",
                      meta.dotClassName,
                    )}
                    title={meta.label}
                  />
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-0.5 leading-none group-data-[collapsible=icon]:hidden">
                <span className="truncate font-medium">
                  {selected ? <MachineLabel name={selected.name} /> : "Unnamed machine"}
                </span>
                <span className="truncate text-xs text-muted-foreground">{meta?.label}</span>
              </div>
              <ChevronsUpDownIcon className="ml-auto group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
            align="start"
          >
            {machines.map((machine) => {
              const itemMeta = MACHINE_STATUS_META[machine.status];
              return (
                <DropdownMenuItem key={machine.id} onSelect={() => handleSelect(machine.id)}>
                  <span
                    className={cn("size-1.5 shrink-0 rounded-full", itemMeta.dotClassName)}
                    title={itemMeta.label}
                  />
                  <span className="truncate">
                    <MachineLabel name={machine.name} />
                  </span>
                  {machine.id === selected?.id && <CheckIcon className="ml-auto size-4" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
