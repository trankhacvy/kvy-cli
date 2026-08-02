/** Quiet hourly time anchor between timeline rows. Purely presentational: the
 * decision of *when* to render one lives in the caller. */
export function HourDivider({ label }: { label: string }) {
  return (
    <div className="my-2 flex items-center gap-2 px-1">
      <div className="h-px flex-1 bg-border/60" aria-hidden="true" />
      <span className="text-[11px] tracking-wide text-muted-foreground/60">{label}</span>
      <div className="h-px flex-1 bg-border/60" aria-hidden="true" />
    </div>
  );
}
