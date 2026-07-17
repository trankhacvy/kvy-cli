"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatRelativeTime } from "@/features/session-list";
import { cn } from "@/lib/utils";
import type { ImportCandidate, NewSessionActions } from "../types";

/**
 * Step 3 (optional): "continue from a recent CLI session" (falcon-prd.md
 * FR-7.8 UC7). Lists `directory`'s recent plain `claude`/`codex` sessions
 * via `actions.listImportCandidates` (the daemon's `adopt.list` RPC) and
 * lets the user pick one to continue, or explicitly start fresh — mirrors
 * `DirectoryStep`'s browse-on-mount shape, and `MachineStep`'s
 * card-as-radio-option selection pattern.
 */
export function ImportStep({
  actions,
  directory,
  selected,
  onSelect,
}: {
  actions: NewSessionActions;
  directory: string;
  selected: ImportCandidate | null;
  onSelect: (candidate: ImportCandidate | null) => void;
}) {
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    actions
      .listImportCandidates(directory)
      .then((items) => {
        if (!cancelled) setCandidates(items);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [actions, directory]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Continue a recent <code className="rounded bg-muted px-1 py-0.5">claude</code> /{" "}
        <code className="rounded bg-muted px-1 py-0.5">codex</code> session in this directory, or
        start a fresh one.
      </p>

      <ImportCandidateOption
        selected={selected === null}
        onClick={() => onSelect(null)}
        title="Start a new session"
      />

      {loading && <p className="text-sm text-muted-foreground">Looking for recent sessions…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!loading && !error && candidates?.length === 0 && (
        <p className="text-xs text-muted-foreground">No recent CLI sessions found here.</p>
      )}

      {candidates?.map((candidate) => (
        <ImportCandidateOption
          key={candidate.providerSessionId}
          selected={selected?.providerSessionId === candidate.providerSessionId}
          onClick={() => onSelect(candidate)}
          title={candidate.title?.trim() || candidate.providerSessionId}
          subtitle={formatRelativeTime(candidate.lastActivityAt)}
          running={candidate.running}
        />
      ))}
    </div>
  );
}

function ImportCandidateOption({
  selected,
  onClick,
  title,
  subtitle,
  running,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  subtitle?: string;
  running?: boolean;
}) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
      className={cn(
        "cursor-pointer flex-row items-center justify-between gap-2 px-4 py-3 hover:bg-accent",
        selected && "border-primary ring-1 ring-primary",
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{title}</span>
        {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
      </div>
      {running && (
        <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
          Running
        </Badge>
      )}
    </Card>
  );
}
