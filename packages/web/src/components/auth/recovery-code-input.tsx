"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The counterpart to `RecoveryCodeCard` (which *exports* a code) — a small
 * controlled text field + submit button for *redeeming* one, used by the
 * `needs-signup` restore flow (`src/app/(public)/signin/page.tsx`). Kept
 * disabled while `pending` so a slow decode/sign-in round trip can't be
 * double-submitted.
 */
export function RecoveryCodeInput({
  onSubmit,
  pending,
}: {
  onSubmit: (code: string) => void;
  pending?: boolean;
}) {
  const [code, setCode] = useState("");

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <form className="flex flex-col gap-2 sm:flex-row" onSubmit={handleSubmit}>
      <Input
        type="text"
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        placeholder="XXXXX-XXXXX-XXXXX-…"
        aria-label="Recovery code"
        data-testid="recovery-code-input"
        value={code}
        disabled={pending}
        onChange={(event) => setCode(event.target.value)}
        className="font-mono"
      />
      <Button type="submit" variant="outline" disabled={pending || code.trim().length === 0}>
        Restore account
      </Button>
    </form>
  );
}
