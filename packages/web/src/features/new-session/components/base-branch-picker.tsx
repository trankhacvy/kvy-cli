"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import type { BranchItem } from "../types";

const INPUT_CLASS =
  "rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Searchable "from ▾" base-branch picker (docs/competitive-notes-omnara.md
 * #16 "Searchable base-branch picker") — extracted verbatim out of the old
 * wizard's `OptionsStep` (B2, new-session-from-web redesign) so the new
 * workspace-row inline creation panel (`new-session-panel.tsx`) can reuse it
 * without forking the logic. Behavior is unchanged from the original: lazily
 * fetches the branch list the first time the trigger is opened (picking a
 * base branch is optional — a session spawned without ever opening this
 * picker shouldn't pay for a `git.branches` round-trip it doesn't need),
 * `selected === ""` means "no base picked" (falls back to whatever's
 * currently checked out).
 */
export function BaseBranchPicker({
  directory,
  listBranches,
  selected,
  onSelect,
  labelledBy,
}: {
  directory: string;
  listBranches: (directory: string) => Promise<BranchItem[]>;
  selected: string;
  onSelect: (name: string) => void;
  /** Id of the visible `<span>` caption standing in for a real `<label>` — the trigger is a `<button>`, not a labelable form control, so `noLabelWithoutControl` needs `aria-labelledby` instead of a wrapping `<label>`. */
  labelledBy: string;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    listBranches(directory)
      .then(setBranches)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: only fetch the first time the picker is opened — `load` itself is redefined every render but isn't part of what should trigger a re-fetch, and re-running once `branches`/`loading` flip after the fetch starts would just refetch forever.
  useEffect(() => {
    if (open && branches === null && !loading) {
      load();
    }
  }, [open]);

  const currentBranchName = branches?.find((b) => b.isCurrent)?.name;
  const triggerLabel = selected || currentBranchName || "current branch";

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby={labelledBy}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          INPUT_CLASS,
          "flex w-full items-center justify-between gap-2 text-left font-normal",
        )}
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="rounded-md border border-border">
          <Command>
            <CommandInput placeholder="Search branches…" />
            <CommandList>
              {loading && <p className="p-3 text-sm text-muted-foreground">Loading branches…</p>}
              {error && (
                <div className="flex flex-col gap-2 p-3">
                  <p className="text-xs text-destructive">{error}</p>
                  <button
                    type="button"
                    className="self-start text-xs underline text-muted-foreground hover:text-foreground"
                    onClick={load}
                  >
                    Retry
                  </button>
                </div>
              )}
              {!loading && !error && <CommandEmpty>No local branches found.</CommandEmpty>}
              {!loading && !error && selected !== "" && (
                <CommandItem
                  value="current branch (default)"
                  data-checked={false}
                  onSelect={() => {
                    onSelect("");
                    setOpen(false);
                  }}
                >
                  Current branch (default)
                </CommandItem>
              )}
              {!loading &&
                !error &&
                branches?.map((branch) => (
                  <CommandItem
                    key={branch.name}
                    value={branch.name}
                    data-checked={branch.name === selected}
                    onSelect={() => {
                      onSelect(branch.name);
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">{branch.name}</span>
                    {branch.isCurrent && (
                      <Badge
                        variant="outline"
                        className="shrink-0 font-normal text-muted-foreground"
                      >
                        current
                      </Badge>
                    )}
                  </CommandItem>
                ))}
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}
