"use client";

import { Fingerprint, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { isPrfAvailable, type KeyWrapMode } from "@/crypto";

/**
 * Key-protection mode selector, shown once at first setup.
 *
 *  - "prf"    — wrap key re-derived from a passkey each session; never exists at rest, so
 *               copying the browser profile yields nothing usable. Costs one biometric tap
 *               per page load.
 *  - "device" — non-extractable key stored in IndexedDB. No prompt, but same-origin script
 *               can use the handle, and anyone who can access this machine can read sessions.
 *
 * Auto-resolves to "device" when no platform authenticator exists.
 */
export function KeyProtectionChoice({
  onChoose,
  pending,
}: {
  onChoose: (mode: KeyWrapMode) => void;
  pending?: boolean;
}) {
  const [prfAvailable, setPrfAvailable] = useState<boolean | null>(null);

  // Pinned in a ref rather than listed as a dependency: every call site passes an inline
  // arrow, so depending on it would re-run this effect each render and re-fire the
  // auto-resolve below.
  const onChooseRef = useRef(onChoose);
  useEffect(() => {
    onChooseRef.current = onChoose;
  }, [onChoose]);

  useEffect(() => {
    let cancelled = false;
    void isPrfAvailable().then((available) => {
      if (cancelled) return;
      setPrfAvailable(available);
      // No platform authenticator here, so there is no choice to offer — resolve to the
      // only mode this browser can actually honour instead of showing a dead option.
      if (!available) onChooseRef.current("device");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (prfAvailable === null || prfAvailable === false) {
    return <p className="text-sm text-muted-foreground">Setting up your keys…</p>;
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-4 text-left">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Protect your keys on this device</h1>
        <p className="text-sm text-muted-foreground">
          Your sessions are end-to-end encrypted. Choose how this browser keeps the keys.
        </p>
      </div>

      <button
        type="button"
        disabled={pending}
        onClick={() => onChoose("prf")}
        className="flex items-start gap-3 rounded-lg border p-4 text-left hover:bg-muted/40 disabled:opacity-60"
      >
        <Fingerprint className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <span>
          <span className="block text-sm font-medium">Ask for my fingerprint</span>
          <span className="block text-sm text-muted-foreground">
            One quick check each time you open Kvy. Someone who steals this computer still can't
            read your sessions.
          </span>
        </span>
      </button>

      <button
        type="button"
        disabled={pending}
        onClick={() => onChoose("device")}
        className="flex items-start gap-3 rounded-lg border p-4 text-left hover:bg-muted/40 disabled:opacity-60"
      >
        <Zap className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <span>
          <span className="block text-sm font-medium">Stay signed in</span>
          <span className="block text-sm text-muted-foreground">
            No prompt, ever. Only choose this on a computer only you can use: anyone who can use it
            can read your sessions.
          </span>
        </span>
      </button>

      <Button variant="ghost" size="sm" disabled={pending} onClick={() => onChoose("device")}>
        Decide later
      </Button>
    </div>
  );
}
