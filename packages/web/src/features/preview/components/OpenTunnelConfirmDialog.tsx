"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The security consent gate shown on every "Open" click: a Cloudflare quick
 * tunnel exposes the local dev server at a PUBLIC, unauthenticated URL —
 * anyone
 * with the link can reach it, and unlike every other Kvy RPC body, that
 * traffic is plain HTTP(S), NOT sealed under the machine's E2E key. This
 * dialog is the mandatory, explicit acknowledgment of that before
 * `openTunnel` ever fires — mirrors `GitToolbar`'s force-push confirm
 * dialog's shape (`Dialog`/`DialogContent`/.../`DialogFooter`).
 */
export function OpenTunnelConfirmDialog({
  port,
  open,
  onOpenChange,
  onConfirm,
}: {
  port: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Make port {port} publicly reachable?</DialogTitle>
          <DialogDescription>
            Opening a tunnel gives ANYONE with the link access to this dev server over the public
            internet: the URL is unauthenticated. Unlike every other Kvy action, this traffic is
            plain HTTP(S), not end-to-end encrypted. The tunnel stays open until you close it or the
            daemon stops.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Open tunnel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
