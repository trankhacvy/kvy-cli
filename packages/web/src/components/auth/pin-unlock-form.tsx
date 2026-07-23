"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Prompts for the PIN that unlocks this browser's already-provisioned key
 * material (`bridge.unlock(pin)`, issue-4-plan.md §6.1/§6.4) — shown on a
 * fresh page load (a new crypto-worker instance always starts locked, see
 * `lib/use-crypto-bridge.ts`). `onForgotPin` is optional so a caller that
 * hasn't wired the rotate-epoch flow yet can omit it without a dead link.
 */
export function PinUnlockForm({
  pending,
  error,
  onSubmit,
  onForgotPin,
}: {
  pending?: boolean;
  error?: string;
  onSubmit: (pin: string) => void;
  onForgotPin?: () => void;
}) {
  const [pin, setPin] = useState("");

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!pin) return;
    onSubmit(pin);
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <div className="space-y-1">
        <p className="text-sm font-medium">Enter your PIN</p>
        <p className="text-sm leading-6 text-muted-foreground">
          Unlocks this browser's encrypted key material for this session.
        </p>
      </div>
      <div className="space-y-2">
        <label htmlFor="unlock-pin" className="text-sm font-medium">
          PIN
        </label>
        <Input
          id="unlock-pin"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          autoFocus
          required
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />
      </div>
      {error && (
        <p className="text-sm text-destructive" aria-live="polite">
          {error}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={pending || pin.length === 0}>
        {pending ? "Unlocking…" : "Unlock"}
      </Button>
      {onForgotPin && (
        <Button type="button" variant="link" className="w-full" onClick={onForgotPin}>
          Forgot your PIN?
        </Button>
      )}
    </form>
  );
}
