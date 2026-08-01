"use client";

/** Settings → Git. Git defaults are now configured per workspace (Workspace settings → Git). */
export function GitSection() {
  return (
    <div className="flex flex-col gap-6">
      {/* Informational only — GitHub connects per machine (`kvy github login`), not per account. */}
      <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold">GitHub</h3>
        <p className="text-sm text-muted-foreground">
          GitHub is not connected through this app. CI checks connect per machine: run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">kvy github login</code>{" "}
          in a terminal on the machine that hosts your sessions, then open a session&apos;s Checks
          tab.
        </p>
      </div>
    </div>
  );
}
