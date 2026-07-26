"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { approveKeyRequest, listKeyRequests } from "@/lib/api";
import { copy } from "@/lib/copy";
import { getToken } from "@/lib/session";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";
import { formatVerificationCode, verificationCode } from "@/lib/verification-code";
import { apiSocket } from "@/sync";

interface Card {
  ephPub: string;
  label: string | null;
  code: string;
  requesterClientKind: string | null;
}

/**
 * Mounted once inside the protected layout. When another device of this account asks for
 * a copy of the keys, show a confirm card.
 *
 * This is the most security-sensitive UI in the product — the moment a human grants full
 * read access to everything — so three things here are controls, not decoration:
 *
 *  1. It NEVER auto-approves. An attacker with a stolen access token can make this card
 *     appear; only a human comparing codes can complete it.
 *  2. The server-attested requester row sits ABOVE the untrusted `label`.
 *  3. Prompt fatigue is the attack, so "Not now" suppresses that `ephPub` for the rest of
 *     the page load and a hard cap replaces further cards with a warning.
 */
const MAX_CARDS_PER_LOAD = 3;

export function KeyRequestListener() {
  const bridge = useCryptoBridge();
  const [card, setCard] = useState<Card | null>(null);
  const [pending, setPending] = useState(false);
  const [abuse, setAbuse] = useState(false);
  const dismissed = useRef(new Set<string>());
  const shown = useRef(0);

  useEffect(() => {
    async function present(ephPub: string, label: string | null): Promise<void> {
      if (dismissed.current.has(ephPub)) return;
      if (shown.current >= MAX_CARDS_PER_LOAD) {
        setAbuse(true);
        return;
      }
      shown.current += 1;

      const token = getToken();
      const listed = token ? await listKeyRequests(token).catch(() => null) : null;
      const match = listed?.requests.find((entry) => entry.ephPub === ephPub);
      setCard({
        ephPub,
        label,
        code: await verificationCode(ephPub),
        requesterClientKind: match?.requesterClientKind ?? null,
      });
    }

    return apiSocket.on("ephemeral", (event) => {
      if (event.t === "key-request") void present(event.ephPub, event.label);
    });
  }, []);

  if (abuse) {
    return (
      <div className="fixed inset-x-0 bottom-4 z-50 mx-auto w-[min(24rem,calc(100%-2rem))] rounded-xl border border-destructive/50 bg-card p-4 shadow-lg">
        <p className="text-sm font-medium text-destructive">{copy.keys.abuseTitle}</p>
        <p className="mt-1 text-sm text-muted-foreground">{copy.keys.abuseBody}</p>
      </div>
    );
  }

  if (!card || !bridge) return null;
  const current = card;

  async function approve(): Promise<void> {
    const token = getToken();
    if (!token || !bridge) return;
    setPending(true);
    try {
      const sealed = await bridge.sealKeysForPeer(current.ephPub);
      await approveKeyRequest(token, { ephPub: current.ephPub, response: sealed });
      setCard(null);
    } finally {
      setPending(false);
    }
  }

  function dismiss(): void {
    dismissed.current.add(current.ephPub);
    setCard(null);
  }

  return (
    <div className="fixed inset-x-0 bottom-4 z-50 mx-auto w-[min(24rem,calc(100%-2rem))] rounded-xl border bg-card p-4 shadow-lg">
      <p className="text-sm font-medium">{copy.keys.approveTitle}</p>
      <p className="mt-1 text-sm text-muted-foreground">{copy.keys.approveBody}</p>

      <dl className="mt-3 space-y-1 rounded-md bg-muted/40 p-3 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Signed in as</dt>
          <dd>{current.requesterClientKind ?? "unknown"}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Says it is</dt>
          <dd className="truncate">{current.label ?? "unnamed"}</dd>
        </div>
      </dl>

      <div className="mt-3 rounded-md border p-3 text-center">
        <p className="text-xs text-muted-foreground">{copy.keys.codeIntroApprover}</p>
        <p className="mt-1 font-mono text-2xl tracking-[0.2em]">
          {formatVerificationCode(current.code)}
        </p>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{copy.keys.codeMismatch}</p>

      <div className="mt-3 flex gap-2">
        {/* `!bridge` is defensive, not reachable today — the outer `if (!card || !bridge)
         *  return null;` above already keeps this whole card unmounted until the bridge
         *  exists — but the button must never be able to look clickable while it can't
         *  do anything (auth-ux-overhaul-fix-plan.md Fix 11), and a future change to
         *  that gate should not silently reopen this. */}
        <Button size="sm" disabled={pending || !bridge} onClick={() => void approve()}>
          {pending ? copy.keys.sendingLabel : copy.keys.sendCta}
        </Button>
        <Button size="sm" variant="ghost" onClick={dismiss}>
          {copy.keys.denyCta}
        </Button>
      </div>
    </div>
  );
}
