"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/timeline/CopyButton";
import { Button } from "@/components/ui/button";
import type { PreviewTunnel } from "../types";

/**
 * How long to wait for the iframe's `load` event before assuming the
 * tunneled dev server refused to be embedded (droppable Phase 6, docs/
 * features/dev-server-preview.md). There is no reliable, standards-based way
 * to detect an `X-Frame-Options`/`frame-ancestors` block from JS — a blocked
 * frame still fires (or never fires, depending on browser/response) `load`
 * without throwing — so this is a heuristic, not a certainty: a slow but
 * ultimately successful dev server could also trip it. Either way the
 * fallback copy always offers the guaranteed "open in a new tab" escape
 * hatch, so a false "refused" verdict costs nothing but the inline preview.
 */
const LOAD_TIMEOUT_MS = 8_000;

/**
 * The embedded live-preview frame (docs/features/dev-server-preview.md's
 * droppable Phase 6): renders `tunnel.url` inline below the ports list once
 * a tunnel is selected for inline preview. `sandbox="allow-scripts
 * allow-same-origin allow-forms"` lets a typical dev server (React/Vite/
 * Next dev overlay, form submissions) actually function while still
 * denying it top-level navigation/popups out of the sandbox.
 *
 * Open-in-new-tab and Copy URL stay visible above the frame at all times —
 * they're the guaranteed path (Phase 5), this embed is progressive
 * enhancement on top, never a replacement.
 *
 * The caller (`PreviewPanel`) renders this keyed on `tunnel.tunnelId` — a
 * fresh component instance per selected tunnel, so switching which tunnel
 * is previewed re-arms `loaded`/`timedOut` via a normal mount rather than an
 * effect keyed on a value never actually read inside it (a fresh 5s poll
 * re-fetches an equal-by-value tunnel object constantly; a dependency on
 * `tunnel.tunnelId` alone would only refire on a real selection change,
 * which `key` already guarantees more simply).
 */
export function TunnelFrame({ tunnel }: { tunnel: PreviewTunnel }) {
  const [loaded, setLoaded] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  const refused = timedOut && !loaded;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 rounded-md border border-border">
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/30 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {tunnel.url}
        </span>
        <CopyButton getText={() => tunnel.url} label="Copy URL" />
        <Button asChild size="sm" variant="outline">
          <a href={tunnel.url} target="_blank" rel="noreferrer">
            <ExternalLink className="size-3.5" />
            Open in new tab
          </a>
        </Button>
      </div>

      {refused ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <p>This app refused to be embedded. Open it in a new tab instead.</p>
          <Button asChild size="sm" variant="outline">
            <a href={tunnel.url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" />
              Open in new tab
            </a>
          </Button>
        </div>
      ) : (
        <iframe
          key={tunnel.tunnelId}
          src={tunnel.url}
          title={`Preview of ${tunnel.url}`}
          sandbox="allow-scripts allow-same-origin allow-forms"
          onLoad={() => setLoaded(true)}
          className="min-h-0 flex-1 border-0"
        />
      )}
    </div>
  );
}
