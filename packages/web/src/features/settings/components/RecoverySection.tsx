"use client";

import { useEffect, useState } from "react";
import { RecoveryCodeCard } from "@/components/auth/recovery-code-card";
import { Button } from "@/components/ui/button";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";

type Status = "checking" | "ready" | "revealed" | "unavailable";

/**
 * Settings → Recovery (design §9.2 Settings: "recovery code export"). Moved
 * verbatim out of the deleted `app/(protected)/settings/recovery/page.tsx`
 * route — page chrome dropped, behavior unchanged. Not shown automatically —
 * the user has to ask for it — since it's the kind of thing someone could be
 * looking at over your shoulder.
 */
export function RecoverySection() {
  const bridge = useCryptoBridge();
  const [status, setStatus] = useState<Status>("checking");
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;

    (async () => {
      const identity = await bridge.getIdentity();
      if (cancelled) return;
      setStatus(identity ? "ready" : "unavailable");
    })();

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  async function reveal() {
    if (!bridge) return;
    const recoveryCode = await bridge.exportRecoveryCode();
    setCode(recoveryCode);
    setStatus("revealed");
  }

  return (
    <div className="flex flex-col items-start gap-4">
      <p className="text-sm text-muted-foreground">
        Anyone with this code can restore your account's key material on another device. Keep it as
        secret as a password.
      </p>

      {status === "checking" && <p className="text-sm text-muted-foreground">Loading…</p>}

      {status === "unavailable" && (
        <p className="text-sm text-destructive">
          This device has no Falcon identity to export. Sign in first.
        </p>
      )}

      {status === "ready" && (
        <Button type="button" onClick={reveal}>
          Reveal recovery code
        </Button>
      )}

      {status === "revealed" && code && <RecoveryCodeCard code={code} />}
    </div>
  );
}
