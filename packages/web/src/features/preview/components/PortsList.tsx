"use client";

import { ExternalLink } from "lucide-react";
import { CopyButton } from "@/components/timeline/CopyButton";
import { Button } from "@/components/ui/button";
import type { PreviewPort, PreviewTunnel } from "../types";

/**
 * One row per detected port: port, process name/pid, and either an "Open"
 * button or — once a tunnel is tracked for that port — the tunnel's URL
 * plus Copy/Preview/Open-in-new-tab/Close actions. Open-in-new-tab is
 * always the guaranteed path here — the optional inline "Preview" toggle
 * (`onPreviewClick`, the optional `TunnelFrame`) is progressive enhancement
 * on top, never a replacement.
 */
export function PortsList({
  ports,
  tunnels,
  onOpenClick,
  onClose,
  isClosePending,
  onPreviewClick,
  selectedTunnelId,
  disabled = false,
}: {
  ports: PreviewPort[];
  tunnels: PreviewTunnel[];
  onOpenClick: (port: number) => void;
  onClose: (tunnelId: string) => void;
  isClosePending: boolean;
  /** Optional — omit to hide the inline "Preview" toggle entirely, e.g. before the embedded-frame CSP allowance has landed. */
  onPreviewClick?: (tunnelId: string) => void;
  selectedTunnelId?: string | null;
  /** `true` once the owning machine is confidently offline/needs-reauth — disables Open/Close, since both are `preview.*` machine RPCs. */
  disabled?: boolean;
}) {
  if (ports.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No listening ports detected.</p>;
  }

  const tunnelByPort = new Map(tunnels.map((t) => [t.port, t]));

  return (
    <ul className="flex flex-col gap-1">
      {ports.map((port) => {
        const tunnel = tunnelByPort.get(port.port);
        return (
          <li
            key={port.port}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
          >
            <span className="font-mono font-medium">:{port.port}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {port.processName ?? "unknown process"}
              {port.pid !== undefined ? ` (pid ${port.pid})` : ""}
            </span>

            {tunnel ? (
              <div className="flex items-center gap-1.5">
                <span
                  className="max-w-40 truncate font-mono text-xs text-muted-foreground sm:max-w-64"
                  title={tunnel.url}
                >
                  {tunnel.url}
                </span>
                <CopyButton getText={() => tunnel.url} label="Copy URL" />
                {onPreviewClick && (
                  <Button
                    size="sm"
                    variant={selectedTunnelId === tunnel.tunnelId ? "secondary" : "outline"}
                    onClick={() => onPreviewClick(tunnel.tunnelId)}
                  >
                    Preview
                  </Button>
                )}
                <Button asChild size="sm" variant="outline">
                  <a href={tunnel.url} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-3.5" />
                    Open
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isClosePending || disabled}
                  onClick={() => onClose(tunnel.tunnelId)}
                >
                  Close
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => onOpenClick(port.port)}
              >
                Open
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
