"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DirectoryListing, NewSessionActions } from "../types";

/**
 * Step 2: browse the chosen machine's filesystem via `actions.browseDirectory`
 * (daemon `fs.list` RPC) and pick a working directory (falcon-prd.md FR-7.5).
 * Directory-not-found (a typo, or a path that hasn't been created yet) is
 * shown inline — the actual create-directory *approval* only happens later,
 * against the exact directory `spawn` rejects (`spawn-flow.ts`), not here.
 */
export function DirectoryStep({
  actions,
  directory,
  onSelect,
}: {
  actions: NewSessionActions;
  directory: string | null;
  onSelect: (path: string) => void;
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [pathInput, setPathInput] = useState(directory ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function browse(path: string | undefined) {
    setLoading(true);
    setError(null);
    try {
      const result = await actions.browseDirectory(path);
      setListing(result);
      setPathInput(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-browse on mount — subsequent navigation is user-driven (clicking an entry/"Go"), and re-running this on every `directory` change would re-fetch the just-picked directory right after `onSelect` bubbles it back up as a prop.
  useEffect(() => {
    browse(directory ?? undefined);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          browse(pathInput.trim());
        }}
      >
        <input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          placeholder="/path/to/project"
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" variant="outline" disabled={loading}>
          Go
        </Button>
      </form>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {listing && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium" title={listing.path}>
              {listing.path}
            </p>
            <Button
              size="sm"
              onClick={() => onSelect(listing.path)}
              variant={directory === listing.path ? "secondary" : "default"}
            >
              {directory === listing.path ? "Selected" : "Use this directory"}
            </Button>
          </div>

          <div className="flex flex-col gap-1 rounded-md border border-border">
            {listing.parent && (
              <button
                type="button"
                onClick={() => browse(listing.parent ?? undefined)}
                className="flex items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent"
              >
                .. (parent)
              </button>
            )}
            {listing.entries.length === 0 && !listing.parent && (
              <p className="px-3 py-2 text-sm text-muted-foreground">Empty directory</p>
            )}
            {listing.entries.map((entry) => (
              <button
                key={entry.name}
                type="button"
                onClick={() => browse(`${listing.path.replace(/\/$/, "")}/${entry.name}`)}
                className="flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
              >
                {entry.name}/
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
