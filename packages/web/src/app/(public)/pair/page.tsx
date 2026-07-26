"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { RequestKeysPanel } from "@/components/auth/request-keys-panel";
import { Button } from "@/components/ui/button";
import { SIGNIN_PATH } from "@/features/auth";
import { ApiError, approvePairing, fetchPairDetails, mintPairSession } from "@/lib/api";
import { copy } from "@/lib/copy";
import { stashPendingPair } from "@/lib/pending-pair";
import { getAccountId, getToken, isSignedIn, silentRefresh } from "@/lib/session";
import { useCryptoBridgeStatus } from "@/lib/use-crypto-bridge-status";
import { type Gate, nextGate, type PairDetails } from "./pair-gate";
import { parseEphPubFromHash } from "./parse-eph-pub";

function formatRelative(iso: string | null): string {
  if (!iso) return "just now";
  const diffSeconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSeconds < 60) return `${Math.max(diffSeconds, 0)}s ago`;
  if (diffSeconds < 3600) return `${Math.round(diffSeconds / 60)}m ago`;
  return `${Math.round(diffSeconds / 3600)}h ago`;
}

/**
 * CLI pairing approval: the CLI prints `app.falcon.dev/pair#<ephPub>` and polls while this
 * already-authenticated browser approves it.
 *
 * docs/auth-ux-overhaul-plan.md AX-2.2: the gate order is IDENTITY FIRST, crypto second.
 * This page used to check the crypto bridge before checking whether the visitor was even
 * signed in, so a fresh browser hit a "no key material … reopen this pairing link" dead
 * end while still signed out.
 */
export default function PairPage() {
  const router = useRouter();
  /** `null` until step 2 below confirms identity — `useCryptoBridgeStatus` stays
   *  `"loading"` until then rather than evaluating readiness for nobody in particular. */
  const [accountId, setAccountId] = useState<string | null>(null);
  const { status: bridgeStatus, refresh } = useCryptoBridgeStatus(accountId);
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  // Hoisted out of the `confirm` gate so the key-fetch detour (below) can restore it —
  // `needs-keys` keeps only `ephPub`, so without this the machine name/folder/timestamp
  // would be lost the moment the bridge reports no keys.
  const [pairDetails, setPairDetails] = useState<PairDetails | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 1. A bad link is a bad link regardless of auth state.
      const ephPub = parseEphPubFromHash(window.location.hash);
      if (!ephPub) {
        setGate({ kind: "invalid-link" });
        return;
      }

      // 2. Identity. A signed-out visitor never sees a crypto screen. The pairing is
      // stashed so sign-in can return here. `!== "ok"` (not a truthiness check): an
      // "unreachable" outcome must NOT be treated as signed in — that would skip the
      // stash + bounce and fall through to `fetchPairDetails` with no token at all.
      if (!isSignedIn() && (await silentRefresh()) !== "ok") {
        if (cancelled) return;
        stashPendingPair(ephPub);
        router.replace(SIGNIN_PATH);
        return;
      }
      if (!cancelled) setAccountId(getAccountId());

      // 3. What are we approving?
      const details = await fetchPairDetails(ephPub).catch(() => null);
      if (cancelled) return;

      const resolvedDetails: PairDetails = {
        label: details?.label ?? null,
        cwd: details?.cwd ?? null,
        requestedAt: details?.requestedAt ?? null,
      };
      setPairDetails(resolvedDetails);
      setGate({ kind: "confirm", ephPub, ...resolvedDetails });
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  // 4. Crypto, second: approving needs the master secret, so a browser without keys is
  // routed to fetch them rather than dead-ended. The detour is REVERSIBLE — see
  // `nextGate`'s docblock for why the demotion needed an inverse.
  useEffect(() => {
    setGate((current) => nextGate(current, bridgeStatus.kind, pairDetails));
  }, [bridgeStatus, pairDetails]);

  async function approve(ephPub: string, label: string | null): Promise<void> {
    if (bridgeStatus.kind !== "ready") return;
    const bridge = bridgeStatus.bridge;
    setGate({ kind: "approving", ephPub });

    let token = getToken();
    if (!token) {
      // This page has a one-shot gate rather than `RequireAuth`'s mounted re-check, so a
      // token that expired between the gate and this click gets one chance to refresh.
      token = (await silentRefresh()) === "ok" ? getToken() : null;
    }
    if (!token) {
      setGate({ kind: "error", message: copy.pair.signedOutMidFlow, ephPub });
      return;
    }

    try {
      // Mint the new device's session server-side FIRST — the resulting refresh token has
      // to reach the crypto worker so it can be sealed alongside the master secret,
      // rather than relayed to the server in plaintext.
      const { refreshToken } = await mintPairSession(token, ephPub);
      const sealed = await bridge.sealForPeer(ephPub, refreshToken);
      await approvePairing(token, { ephPub, response: sealed });
      setGate({ kind: "approved", label });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Approval failed. Please retry.";
      setGate({ kind: "error", message, ephPub });
    }
  }

  if (gate.kind === "needs-keys") {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <RequestKeysPanel
          onReady={() => void refresh()}
          context={copy.pair.resumeAfterKeys(pairDetails?.label ?? copy.pair.unknownMachine)}
        />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      {gate.kind === "checking" && (
        <p className="text-sm text-muted-foreground">{copy.pair.checking}</p>
      )}

      {gate.kind === "invalid-link" && (
        <p className="max-w-sm text-center text-sm text-destructive">{copy.pair.invalidLink}</p>
      )}

      {gate.kind === "confirm" && (
        <div className="w-full max-w-sm space-y-4 text-left">
          <h1 className="text-xl font-semibold">{copy.pair.approveTitle}</h1>
          <dl className="rounded-lg border p-4 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Machine</dt>
              <dd className="font-medium">{gate.label ?? copy.pair.unknownMachine}</dd>
            </div>
            {gate.cwd && (
              <div className="mt-2 flex justify-between gap-4">
                <dt className="text-muted-foreground">Folder</dt>
                <dd className="truncate font-mono text-xs">{gate.cwd}</dd>
              </div>
            )}
            <div className="mt-2 flex justify-between gap-4">
              <dt className="text-muted-foreground">Requested</dt>
              <dd>{formatRelative(gate.requestedAt)}</dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">{copy.pair.approveWarning}</p>
          <div className="flex gap-3">
            <Button
              type="button"
              disabled={bridgeStatus.kind !== "ready"}
              onClick={() => void approve(gate.ephPub, gate.label)}
            >
              {bridgeStatus.kind === "ready" ? copy.pair.approveCta : copy.pair.preparingCta}
            </Button>
            <Button type="button" variant="outline" onClick={() => router.replace("/dashboard/")}>
              {copy.pair.cancelCta}
            </Button>
          </div>
        </div>
      )}

      {gate.kind === "approving" && (
        <p className="text-sm text-muted-foreground">{copy.pair.approvingLabel}</p>
      )}

      {gate.kind === "approved" && (
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          <div className="rounded-full bg-emerald-500/10 p-3">
            <Check className="size-6 text-emerald-600" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold">{copy.pair.doneTitle}</h1>
          <p className="text-sm text-muted-foreground">
            {copy.pair.doneBody(gate.label ?? "Your machine")}
          </p>
          <Button type="button" variant="outline" onClick={() => router.replace("/dashboard/")}>
            {copy.pair.doneCta}
          </Button>
        </div>
      )}

      {gate.kind === "error" && (
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-sm text-destructive">{gate.message}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setGate({
                kind: "confirm",
                ephPub: gate.ephPub,
                label: null,
                cwd: null,
                requestedAt: null,
              })
            }
          >
            {copy.pair.retryCta}
          </Button>
        </div>
      )}
    </main>
  );
}
