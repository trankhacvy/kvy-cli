"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const MIN_PIN_LENGTH = 6;

/**
 * Collects a new PIN (+ confirmation) for `bridge.init(masterSecret, pin)`
 * (issue-4-plan.md §6.1) — this PIN, not the account password, is what
 * PIN-wraps the master secret at rest. Deliberately a plain numeric-ish text
 * field (no fixed digit count enforced beyond a floor) rather than a
 * fixed-length OTP-style input: the underlying KDF (`wrapWithPin`) accepts
 * any non-empty string.
 */
export function PinSetupForm({
  pending,
  onSubmit,
}: {
  pending?: boolean;
  onSubmit: (pin: string) => void;
}) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);

  const tooShort = pin.length > 0 && pin.length < MIN_PIN_LENGTH;
  const mismatch = touched && confirm.length > 0 && pin !== confirm;
  const canSubmit = pin.length >= MIN_PIN_LENGTH && pin === confirm;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    onSubmit(pin);
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <div className="space-y-1">
        <p className="text-sm font-medium">Create a PIN</p>
        <p className="text-sm leading-6 text-muted-foreground">
          Protects your encrypted key material on this device. You'll need it again after a reload —
          Falcon never stores it, so there's no way to recover a lost PIN except rotating your keys
          from another signed-in device.
        </p>
      </div>
      <div className="space-y-2">
        <label htmlFor="new-pin" className="text-sm font-medium">
          PIN
        </label>
        <Input
          id="new-pin"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          minLength={MIN_PIN_LENGTH}
          required
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="confirm-pin" className="text-sm font-medium">
          Confirm PIN
        </label>
        <Input
          id="confirm-pin"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onBlur={() => setTouched(true)}
        />
      </div>
      {tooShort && (
        <p className="text-sm text-destructive">
          PIN must be at least {MIN_PIN_LENGTH} characters.
        </p>
      )}
      {mismatch && <p className="text-sm text-destructive">PINs don't match.</p>}
      <Button type="submit" className="w-full" disabled={pending || !canSubmit}>
        {pending ? "Please wait…" : "Set PIN"}
      </Button>
    </form>
  );
}
