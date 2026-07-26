"use client";

import { useState } from "react";
import { StartOverLink } from "@/components/auth/start-over-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { provisionKeyProtection } from "@/crypto";
import { getAccountId } from "@/lib/session";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";

/**
 * One-time upgrade for browsers provisioned before the PIN was removed. Shown only when
 * `describeStorage()` reports a version-1 record; after a successful unlock the key
 * material is re-wrapped under the current scheme and this never appears again.
 *
 * A user who has forgotten their PIN takes the ordinary `RequestKeysPanel` path instead
 * (reachable via the link below), exactly like any other keyless browser.
 */
export function MigratePinPrompt({ onMigrated }: { onMigrated: () => void }) {
  const bridge = useCryptoBridge();
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!bridge) return;
    setPending(true);
    setError(null);
    // Keep the same protection the browser would get on a fresh setup — the passkey
    // prompt (if any) happens here on the main thread, never inside the worker.
    const protection = await provisionKeyProtection("prf", getAccountId() ?? "Falcon");
    const ok = await bridge.migrateFromPin(pin, protection);
    setPending(false);
    if (ok) {
      onMigrated();
      return;
    }
    setError("That PIN didn't work. Try again.");
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4 text-left">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">One last time</h1>
        <p className="text-sm text-muted-foreground">
          Falcon doesn't ask for a PIN any more. Enter yours once and this browser will stop asking.
        </p>
      </div>
      <Input
        type="password"
        inputMode="numeric"
        autoComplete="current-password"
        value={pin}
        onChange={(event) => setPin(event.target.value)}
        placeholder="Your PIN"
        aria-label="Your PIN"
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={pending || pin.length === 0}>
        {pending ? "Checking…" : "Continue"}
      </Button>
      <StartOverLink />
    </form>
  );
}
