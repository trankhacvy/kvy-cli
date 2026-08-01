"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { ImportCandidate } from "@/features/new-session";
import { formatRelativeTime } from "@/features/session-list";
import { cn } from "@/lib/utils";

/**
 * "Continue from a recent CLI session" (kvy-prd.md FR-7.8 UC7) — the old
 * wizard's `ImportStep`'s new home (B5, new-session-from-web redesign, see
 * the task's own header comment). `ImportStep` itself wasn't actually
 * dependent on free-form directory *browsing* — it only ever needed an
 * already-resolved `directory` string, which this panel always already has
 * (a workspace's own registered id/path). So rather than dropping the
 * feature, it moves here, folded into the inline panel's Advanced
 * disclosure (closed by default, same as provider/permission/model) since
 * "continue an existing session" is a secondary choice, not the primary
 * "Start session" action.
 *
 * Same browse-on-mount/card-radio-option shape as the original.
 */
export function ContinueSessionPicker({
  listImportCandidates,
  directory,
  selected,
  onSelect,
}: {
  listImportCandidates: (directory: string) => Promise<ImportCandidate[]>;
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
    listImportCandidates(directory)
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
  }, [listImportCandidates, directory]);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">Continue from a recent session</p>

      <ImportCandidateOption
        selected={selected === null}
        onClick={() => onSelect(null)}
        title="Start fresh"
      />

      {loading && <p className="text-xs text-muted-foreground">Looking for recent sessions…</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
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
        "cursor-pointer flex-row items-center justify-between gap-2 px-3 py-2 hover:bg-accent",
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
