"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DirectoryListing, NewSessionActions } from "../types";
import { isDirectoryAlreadyLive, isDirectoryNotFoundError } from "./directory-step-logic";

/**
 * Step 2: browse the chosen machine's filesystem via `actions.browseDirectory`
 * (daemon `fs.list` RPC) and pick a working directory (falcon-prd.md FR-7.5).
 *
 * A typed path that doesn't exist yet (a typo, or a brand-new project
 * directory the user hasn't created) 404s the browse call — `onSelect` can't
 * be wired to the *listing* in that case (there is none), so it's wired to
 * a dedicated "use this path anyway" affordance shown alongside the error
 * instead, letting `form.directory` hold a not-yet-existing path. That's
 * what makes the create-directory *approval* loop (`spawn-flow.ts`'s
 * `runSpawnFlow`, driven off the exact directory `spawn` rejects) reachable
 * from this wizard at all.
 */
export function DirectoryStep({
  actions,
  directory,
  onSelect,
  liveDirectories = [],
}: {
  actions: NewSessionActions;
  directory: string | null;
  onSelect: (path: string) => void;
  /**
   * Best-effort set of directories that already have a live session
   * somewhere (plan.md §16 "Flow 3 — spawn-directory-dedup" item 4) — backs
   * a non-blocking warning only; this is racy across devices, so the
   * directory stays fully selectable. The daemon's own `spawn`-time dedup
   * guard is the authoritative check. Defaults to none (no warning) when
   * the caller doesn't have this data wired up yet.
   */
  liveDirectories?: string[];
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [pathInput, setPathInput] = useState(directory ?? "");
  const [error, setError] = useState<string | null>(null);
  const [notFoundPath, setNotFoundPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function browse(path: string | undefined) {
    setLoading(true);
    setError(null);
    setNotFoundPath(null);
    try {
      const result = await actions.browseDirectory(path);
      setListing(result);
      setPathInput(result.path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      if (path && isDirectoryNotFoundError(message)) {
        setNotFoundPath(path);
      }
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

      {error && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-destructive">{error}</p>
          {notFoundPath && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border p-2">
              <p
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                title={notFoundPath}
              >
                Doesn&apos;t exist yet — you can still use it; it&apos;ll be created when you spawn.
              </p>
              <Button
                size="sm"
                variant={directory === notFoundPath ? "secondary" : "default"}
                onClick={() => onSelect(notFoundPath)}
              >
                {directory === notFoundPath ? "Selected" : "Use this path anyway"}
              </Button>
            </div>
          )}
        </div>
      )}

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

          {isDirectoryAlreadyLive(listing.path, liveDirectories) && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              A session may already be running in this directory — picking it will resume that
              session rather than start a new one.
            </p>
          )}

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
            {listing.entries.length === 0 && (
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
