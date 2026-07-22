"use client";

import { QrCode } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CopyButton } from "./CopyButton";
import { QrCodeSvg } from "./QrCodeSvg";

/**
 * Builds the absolute, shareable URL for a session (`origin +
 * /session/<id>/` — the same trailing-slash convention every other in-app
 * link to a session already uses: `SessionGitScreen.tsx`, `session-card.tsx`,
 * `take-over-dialog.tsx`, `new-session-screen.tsx`). Exported standalone
 * (pure, no `window` access) so it's directly unit-testable without
 * mounting the dialog below.
 */
export function sessionShareUrl(origin: string, sessionId: string): string {
  return `${origin}/session/${sessionId}/`;
}

/**
 * "Continue on mobile" QR-code handoff (docs/competitive-notes-omnara.md
 * #11): a header button that opens a dialog showing a QR code encoding this
 * session's own URL, plus a copy-link button — scan-to-open on a phone (the
 * same PWA, since Falcon has no separate mobile app), or paste the link
 * anywhere. Session content itself stays end-to-end encrypted regardless —
 * this only hands off *which session to open*, the same as any other link
 * to `/session/<id>/`; whoever opens it still needs to be signed in.
 *
 * The URL is derived from `window.location.origin` only once the dialog is
 * actually open — `open` defaults to `false`, so the ternary below never
 * touches `window` on the very first render, matching `oauth.ts`'s
 * `callbackUrl` precedent (also never read outside a user-triggered branch)
 * and keeping this safe under `next build`'s static prerender pass (no
 * `window` there at all).
 */
export function MobileHandoffButton({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const url = open ? sessionShareUrl(window.location.origin, sessionId) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <QrCode className="size-3.5" />
          Continue on mobile
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Continue on mobile</DialogTitle>
          <DialogDescription>
            Scan to open this session on your phone, or copy the link below.
          </DialogDescription>
        </DialogHeader>
        {url && (
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-lg border border-border bg-white p-3">
              <QrCodeSvg value={url} className="size-48" />
            </div>
            <div className="flex w-full items-center gap-2">
              <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
              <CopyButton getText={() => url} label="Copy session link" />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
