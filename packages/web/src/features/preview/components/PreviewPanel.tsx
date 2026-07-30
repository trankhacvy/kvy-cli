"use client";

import { useState } from "react";
import { MachineOfflineNotice } from "@/components/machine-offline-notice";
import { useMachineOnline } from "@/lib/use-machine-online";
import type { UsePreviewActions } from "../types";
import { useLivePreviewActions } from "../use-live-preview-actions";
import { usePreviewPanel } from "../use-preview-panel";
import { OpenTunnelConfirmDialog } from "./OpenTunnelConfirmDialog";
import { PortsList } from "./PortsList";
import { TunnelFrame } from "./TunnelFrame";

/**
 * The "Preview" tab (docs/features/dev-server-preview.md — "Live dev-server
 * preview via secure tunnel", docs/competitive-notes-omnara.md #6): header
 * copy is Omnara's own "N ports detected · M tunnels active" verbatim, a
 * `cloudflared`-missing banner when it isn't found on PATH, the ports list
 * (`PortsList`), and the mandatory per-open consent dialog
 * (`OpenTunnelConfirmDialog`) — every `openTunnel` call goes through it,
 * never fired directly from a row's "Open" button.
 *
 * `useActions` is the injectable seam — mirrors `GitDiffPanel`'s/
 * `ChecksPanel`'s own `useActions` prop. Defaults to the real
 * `useLivePreviewActions` (gated on the target machine's unwrapped DEK) —
 * `mock-source.ts`'s `useMockPreviewActions` stays exported for tests/
 * standalone review.
 */
export function PreviewPanel({
  machineId,
  useActions = useLivePreviewActions,
}: {
  machineId: string;
  useActions?: UsePreviewActions;
}) {
  const actions = useActions(machineId);
  const machine = useMachineOnline(machineId);
  const panel = usePreviewPanel(actions, machineId, !machine.isKnownUnavailable);
  const [confirmPort, setConfirmPort] = useState<number | null>(null);
  const [selectedTunnelId, setSelectedTunnelId] = useState<string | null>(null);
  const selectedTunnel = panel.tunnels.find((t) => t.tunnelId === selectedTunnelId) ?? null;

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <MachineOfflineNotice state={machine} />
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">
          {panel.ports.length} ports detected · {panel.tunnels.length} tunnels active
        </h2>
      </div>

      {panel.cloudflaredMissing && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <code>cloudflared</code> isn&apos;t installed on this machine —{" "}
          <code>brew install cloudflared</code> (or see{" "}
          <a
            href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Cloudflare&apos;s install docs
          </a>
          ) to enable tunnels.
        </p>
      )}

      {panel.portsError && (
        <p className="text-sm text-destructive">Could not list ports: {panel.portsError}</p>
      )}

      {panel.isPortsLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Detecting ports…</p>
      ) : (
        <PortsList
          ports={panel.ports}
          tunnels={panel.tunnels}
          onOpenClick={setConfirmPort}
          onClose={(tunnelId) => {
            if (tunnelId === selectedTunnelId) setSelectedTunnelId(null);
            panel.closeTunnel(tunnelId);
          }}
          isClosePending={panel.isClosePending}
          disabled={machine.isKnownUnavailable}
          onPreviewClick={(tunnelId) =>
            setSelectedTunnelId((current) => (current === tunnelId ? null : tunnelId))
          }
          selectedTunnelId={selectedTunnelId}
        />
      )}

      {panel.openError && (
        <p className="text-sm text-destructive">Could not open tunnel: {panel.openError}</p>
      )}
      {panel.closeError && (
        <p className="text-sm text-destructive">Could not close tunnel: {panel.closeError}</p>
      )}

      {selectedTunnel && <TunnelFrame key={selectedTunnel.tunnelId} tunnel={selectedTunnel} />}

      <OpenTunnelConfirmDialog
        port={confirmPort}
        open={confirmPort !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmPort(null);
        }}
        onConfirm={() => {
          if (confirmPort === null) return;
          panel.resetOpenError();
          panel.openTunnel(confirmPort);
        }}
      />
    </div>
  );
}
