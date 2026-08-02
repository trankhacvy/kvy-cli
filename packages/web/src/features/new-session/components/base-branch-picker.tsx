"use client";

import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { BranchItem } from "../types";

const TRIGGER_CLASS =
  "rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function BaseBranchPicker({
  branches,
  loading,
  error,
  onRetry,
  selected,
  onSelect,
  labelledBy,
}: {
  branches: BranchItem[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  selected: string;
  onSelect: (name: string) => void;
  labelledBy: string;
}) {
  const currentBranchName = branches?.find((b) => b.isCurrent)?.name;
  const triggerLabel = selected || currentBranchName || "Current branch (default)";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-labelledby={labelledBy}
          className={cn(
            TRIGGER_CLASS,
            "flex w-full items-center justify-between gap-2 text-left font-normal",
          )}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          <CommandInput autoFocus placeholder="Search branches…" />
          <CommandList>
            {loading && <p className="p-3 text-sm text-muted-foreground">Loading branches…</p>}
            {error !== null && !loading && (
              <div className="flex flex-col gap-2 p-3">
                <p className="text-xs text-destructive">{error}</p>
                <button
                  type="button"
                  className="self-start text-xs underline text-muted-foreground hover:text-foreground"
                  onClick={onRetry}
                >
                  Retry
                </button>
              </div>
            )}
            {!loading && error === null && <CommandEmpty>No local branches found.</CommandEmpty>}
            {!loading && error === null && (
              <CommandItem
                value="current-branch-default"
                data-checked={selected === ""}
                onSelect={() => onSelect("")}
              >
                Current branch (default)
              </CommandItem>
            )}
            {!loading &&
              error === null &&
              branches?.map((branch) => (
                <CommandItem
                  key={branch.name}
                  value={branch.name}
                  data-checked={branch.name === selected}
                  onSelect={() => onSelect(branch.name)}
                >
                  <span className="truncate">{branch.name}</span>
                  {branch.isCurrent && (
                    <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
                      current
                    </Badge>
                  )}
                </CommandItem>
              ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
