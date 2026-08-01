"use client";

import { AlertTriangle, Check, Laptop, Unlink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthArtPanel } from "@/components/auth/auth-art-panel";
import { AuthBrandMark } from "@/components/auth/auth-brand-mark";
import { InlineCodeText } from "@/components/auth/inline-code-text";
import { RequestKeysPanel } from "@/components/auth/request-keys-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SIGNIN_PATH } from "@/features/auth";
import { ApiError, approvePairing, fetchPairDetails, mintPairSession } from "@/lib/api";
import { copy } from "@/lib/copy";
import { stashPendingPair } from "@/lib/pending-pair";
import { getAccountId, getToken, isSignedIn, silentRefresh } from "@/lib/session";
import { useCryptoBridgeStatus } from "@/lib/use-crypto-bridge-status";
import { type Gate, nextGate, type PairDetails } from "./pair-gate";
import { parseEphPubFromHash } from "./parse-eph-pub";

/** How long the `approved` gate sits on its success card before auto-navigating to the
 *  dashboard — long enough to read "Connected", short enough not to feel stuck. */
const APPROVED_REDIRECT_MS = 3000;

/** Splits a path so its last segment (the folder name itself) can be pinned non-shrinking
 *  while the rest truncates with an ellipsis — an end-truncated `~/code/very-long-monorepo-name`
 *  hides the one thing (`very-long-monorepo-name`) the user actually needs to recognize. */
function splitPathTail(path: string): { head: string; tail: string } {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1
    ? { head: "", tail: trimmed }
    : { head: trimmed.slice(0, idx + 1), tail: trimmed.slice(idx + 1) };
}

function formatRelative(iso: string | null): string {
  if (!iso) return "just now";
  const diffSeconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSeconds < 60) return `${Math.max(diffSeconds, 0)}s ago`;
  if (diffSeconds < 3600) return `${Math.round(diffSeconds / 60)}m ago`;
  return `${Math.round(diffSeconds / 3600)}h ago`;
}

/**
 * CLI pairing approval: the CLI prints `app.kvy.dev/pair#<ephPub>` and polls while this
 * already-authenticated browser approves it.
 *
 * docs/auth-ux-overhaul-plan.md AX-2.2: the gate order is IDENTITY FIRST, crypto second.
 * This page used to check the crypto bridge before checking whether the visitor was even
 * signed in, so a fresh browser hit a "no key material … reopen this pairing link" dead
 * end while still signed out.
 *
 * Layout shares `/signin`'s shell (`AuthArtPanel`, `AuthBrandMark`) so a page whose whole
 * job is "prove to the user this approval request is legit" doesn't show up unbranded —
 * see docs' review notes on this page for why that matters more here than anywhere else.
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
  // would be lost the moment the bridge reports no keys. Also what a failed approval's
  // Retry button reads from, so it doesn't fall back to "Unknown machine" on a browser
  // that already knew better.
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

  // 5. Once approved, the CLI is already unblocked (it picked up the sealed box the moment
  // `approvePairing` settled) — this browser has nothing further to do here, so send it on
  // to the dashboard rather than leaving it stranded on a static success card.
  useEffect(() => {
    if (gate.kind !== "approved") return;
    const timer = setTimeout(() => router.replace("/dashboard/"), APPROVED_REDIRECT_MS);
    return () => clearTimeout(timer);
  }, [gate.kind, router]);

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

  const machineLabel = pairDetails?.label ?? copy.pair.unknownMachine;

  return (
    <main className="min-h-svh bg-background p-4 sm:p-5">
      <div className="flex min-h-[calc(100svh-2rem)] sm:min-h-[calc(100svh-2.5rem)]">
        <section className="flex grow items-center justify-center px-6 py-12">
          <div className="w-full max-w-sm">
            <AuthBrandMark className="mb-10 justify-center lg:hidden" />

            {(gate.kind === "checking" || gate.kind === "approving") && (
              <div className="flex flex-col items-center gap-3 py-6 text-center" aria-live="polite">
                <Spinner className="size-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {gate.kind === "checking"
                    ? copy.pair.checking
                    : copy.pair.approvingLabel(machineLabel)}
                </p>
              </div>
            )}

            {gate.kind === "invalid-link" && (
              <div className="flex flex-col items-center gap-4 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-amber-500/10">
                  <Unlink
                    className="size-5 text-amber-600 dark:text-amber-400"
                    aria-hidden="true"
                  />
                </span>
                <div className="space-y-2">
                  <h1 className="font-semibold text-xl tracking-tight">
                    {copy.pair.invalidLinkTitle}
                  </h1>
                  <p className="text-sm leading-6 text-muted-foreground">
                    <InlineCodeText text={copy.pair.invalidLinkBody} />
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="h-11"
                  onClick={() => router.push("/")}
                >
                  {copy.pair.backCta}
                </Button>
              </div>
            )}

            {gate.kind === "needs-keys" && (
              <RequestKeysPanel
                onReady={() => void refresh()}
                context={copy.pair.resumeAfterKeys(machineLabel)}
              />
            )}

            {gate.kind === "confirm" && (
              <div className="space-y-6 text-left">
                <div className="space-y-2">
                  <h1 className="font-semibold text-2xl tracking-tight">
                    {copy.pair.approveTitle}
                  </h1>
                  <p className="text-sm leading-6 text-muted-foreground">
                    {copy.pair.confirmSubtitle}
                  </p>
                </div>

                <div className="rounded-xl border border-border/70 bg-card/60 p-4">
                  <div className="flex items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Laptop className="size-4.5 text-foreground" aria-hidden="true" />
                    </span>
                    <p className="font-medium text-sm">{gate.label ?? copy.pair.unknownMachine}</p>
                  </div>
                  <dl className="mt-4 space-y-2 border-border/60 border-t pt-4 text-sm">
                    {gate.cwd && (
                      <div className="flex items-center justify-between gap-4">
                        <dt className="shrink-0 text-muted-foreground">Folder</dt>
                        <dd className="flex min-w-0 font-mono text-xs">
                          <span className="truncate">{splitPathTail(gate.cwd).head}</span>
                          <span className="shrink-0">{splitPathTail(gate.cwd).tail}</span>
                        </dd>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">Requested</dt>
                      <dd>{formatRelative(gate.requestedAt)}</dd>
                    </div>
                  </dl>
                </div>

                <Alert className="border-amber-500/30 bg-amber-500/10">
                  <AlertTriangle
                    className="size-4 text-amber-600 dark:text-amber-400"
                    aria-hidden="true"
                  />
                  <AlertDescription className="text-amber-700 dark:text-amber-400">
                    <InlineCodeText text={copy.pair.approveWarning} />
                  </AlertDescription>
                </Alert>

                <div className="flex gap-3">
                  <Button
                    type="button"
                    size="lg"
                    className="h-11 flex-1 gap-2"
                    disabled={bridgeStatus.kind !== "ready"}
                    onClick={() => void approve(gate.ephPub, gate.label)}
                  >
                    {bridgeStatus.kind === "ready" ? copy.pair.approveCta : copy.pair.preparingCta}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="h-11 flex-1"
                    onClick={() => router.replace("/dashboard/")}
                  >
                    {copy.pair.cancelCta}
                  </Button>
                </div>
              </div>
            )}

            {gate.kind === "approved" && (
              <div className="flex flex-col items-center gap-4 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-emerald-500/10">
                  <Check
                    className="size-5 text-emerald-600 dark:text-emerald-400"
                    aria-hidden="true"
                  />
                </span>
                <div className="space-y-2">
                  <h1 className="font-semibold text-2xl tracking-tight">{copy.pair.doneTitle}</h1>
                  <p className="text-sm leading-6 text-muted-foreground">
                    {copy.pair.doneBody(gate.label ?? copy.pair.unknownMachine)}
                  </p>
                  <p className="text-xs text-muted-foreground" aria-live="polite">
                    {copy.pair.doneRedirectHint}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="h-11"
                  onClick={() => router.replace("/dashboard/")}
                >
                  {copy.pair.doneCta}
                </Button>
              </div>
            )}

            {gate.kind === "error" && (
              <div className="flex flex-col items-center gap-4 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
                  <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
                </span>
                <div className="space-y-2">
                  <h1 className="font-semibold text-2xl tracking-tight">{copy.pair.errorTitle}</h1>
                  <p className="text-sm leading-6 text-muted-foreground">{gate.message}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="h-11"
                  onClick={() =>
                    setGate({
                      kind: "confirm",
                      ephPub: gate.ephPub,
                      label: pairDetails?.label ?? null,
                      cwd: pairDetails?.cwd ?? null,
                      requestedAt: pairDetails?.requestedAt ?? null,
                    })
                  }
                >
                  {copy.pair.retryCta}
                </Button>
              </div>
            )}
          </div>
        </section>

        <AuthArtPanel caption={copy.signin.panelCaption} />
      </div>
    </main>
  );
}
