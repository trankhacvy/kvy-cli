"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { StartOverLink } from "@/components/auth/start-over-link";
import { provisionKeyProtection } from "@/crypto";
import { claimKeyRequest, createKeyRequest, listDeviceSessions } from "@/lib/api";
import { copy } from "@/lib/copy";
import { describeThisBrowser } from "@/lib/describe-device";
import { getAccountId, getToken } from "@/lib/session";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";
import { formatVerificationCode, verificationCode } from "@/lib/verification-code";

const POLL_MS = 2000;

type Phase =
  | { kind: "starting" }
  | { kind: "waiting"; code: string; devices: string[] }
  | { kind: "error"; message: string };

/**
 * Shown wherever this browser is signed in but has no key material: it asks the account's
 * other devices for a copy instead of dead-ending on the destructive rotate flow, which
 * is demoted to `StartOverLink` below.
 *
 * Continues by itself — it polls `claim` until the sealed box appears, so the user never
 * reloads or re-opens a link. Polling (rather than relying only on the socket ephemeral)
 * is also what keeps this working against a stale, service-worker-cached build that can't
 * parse the new `key-request` payload.
 */
export function RequestKeysPanel({
  onReady,
  context,
}: {
  onReady: () => void;
  /** One line naming what happens after the keys land — e.g. which machine is waiting to
   *  be connected. Without it, `/pair/`'s detour reads as two unrelated prompts in a row.
   *  Render-only: never add this to an effect's dependency array (see `onReadyRef` above —
   *  the same "a fresh identity every render re-mints a key request" hazard applies to any
   *  prop this component depends on inside `start`). */
  context?: string;
}) {
  const bridge = useCryptoBridge();
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });

  // Both call sites pass an inline arrow, so a raw `onReady` in the deps array would give
  // a new identity every render — the effect would re-run, minting a fresh keypair and
  // POSTing a new request each time, popping a new card on the holder device until the
  // rate limit tripped. Pin it in a ref and depend only on `bridge`.
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  const start = useCallback(
    async (signal: { cancelled: boolean }) => {
      if (!bridge) return;
      const token = getToken();
      if (!token) {
        setPhase({ kind: "error", message: copy.keys.signedOut });
        return;
      }

      const ephPub = await bridge.beginKeyRequest();
      const code = await verificationCode(ephPub);
      await createKeyRequest(token, { ephPub, label: describeThisBrowser() });

      const sessions = await listDeviceSessions(token).catch(() => null);
      if (signal.cancelled) return;
      setPhase({
        kind: "waiting",
        code,
        devices: (sessions?.sessions ?? [])
          .filter((session) => !session.isCurrent)
          .map((session) => session.label ?? session.clientKind),
      });

      const poll = async (): Promise<void> => {
        if (signal.cancelled) return;
        try {
          const result = await claimKeyRequest(token, ephPub);
          if (result.state === "ready") {
            const protection = await provisionKeyProtection("prf", getAccountId() ?? "Falcon");
            const accepted = await bridge.acceptKeyResponse(result.response, protection);
            if (accepted) {
              onReadyRef.current();
              return;
            }
            setPhase({ kind: "error", message: copy.keys.unreadable });
            return;
          }
          if (result.state === "expired") {
            setPhase({ kind: "error", message: copy.keys.timedOut });
            return;
          }
        } catch {
          // Transient — keep polling.
        }
        setTimeout(() => void poll(), POLL_MS);
      };
      setTimeout(() => void poll(), POLL_MS);
    },
    [bridge],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void start(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [start]);

  return (
    <div className="flex w-full max-w-sm flex-col gap-5 text-left">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">{copy.keys.needKeysTitle}</h1>
        <p className="text-sm text-muted-foreground">{copy.keys.needKeysBody}</p>
        {context && <p className="text-sm text-muted-foreground">{context}</p>}
      </div>

      {phase.kind === "starting" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {copy.keys.needKeysStarting}
        </div>
      )}

      {phase.kind === "waiting" && (
        <>
          <div className="rounded-lg border bg-muted/30 p-4 text-center">
            <p className="text-sm text-muted-foreground">{copy.keys.codeIntroRequester}</p>
            <p className="mt-2 font-mono text-3xl tracking-[0.2em]">
              {formatVerificationCode(phase.code)}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">{copy.keys.codeMismatchRequester}</p>
          </div>

          <ul className="divide-y rounded-lg border">
            {phase.devices.map((device) => (
              <li key={device} className="flex items-center justify-between px-4 py-3 text-sm">
                <span>{device}</span>
                <span className="text-xs text-muted-foreground">{copy.keys.waitingLabel}</span>
              </li>
            ))}
            {phase.devices.length === 0 && (
              <li className="px-4 py-3 text-sm text-muted-foreground">
                {copy.keys.noOtherDevices} {copy.keys.noOtherDevicesHint("falcon keys approve")}
              </li>
            )}
          </ul>

          <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {copy.keys.waitingBody}
          </div>
        </>
      )}

      {phase.kind === "error" && <p className="text-sm text-destructive">{phase.message}</p>}

      <StartOverLink />
    </div>
  );
}
