"use client";

import { decodeBase64, encodeBase64 } from "@falcon/crypto/web";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PinUnlockForm } from "@/components/auth/pin-unlock-form";
import { Button } from "@/components/ui/button";
import { ApiError, approvePairing, mintPairSession } from "@/lib/api";
import { stashPendingPair } from "@/lib/pending-pair";
import { getToken, isSignedIn, silentRefresh } from "@/lib/session";
import { useUnlockedCryptoBridge } from "@/lib/use-unlocked-crypto-bridge";
import { resolvePairGate } from "./pair-gate";

const X25519_PUBLIC_KEY_BYTES = 32;

type Status =
  | { kind: "checking" }
  | { kind: "invalid-link" }
  | { kind: "confirm"; ephPub: string }
  | { kind: "approving"; ephPub: string }
  | { kind: "approved" }
  | { kind: "error"; message: string; ephPub: string };

// CLI pairing approval (design §5.2 "CLI pairing"): the CLI prints
// `app.falcon.dev/pair#<ephPub>` and polls `/v1/auth/pair/status` while this
// already-authenticated browser visits the link and approves it.
//
// issue-4-plan.md §6.1/§6.3: approving now needs the crypto worker UNLOCKED
// (`bridge.sealForPeer` seals the verbatim master secret + a fresh refresh
// token, both of which only exist in an unlocked worker's memory) — a fresh
// page load (this link is very plausibly the FIRST thing opened in a new
// tab/browser session) starts locked, so this page gates on
// `useUnlockedCryptoBridge()` the same way `RequireAuth`/`password/page.tsx` do,
// rather than assuming whatever `useCryptoBridge()` hands back is already usable.
export default function PairPage() {
  const router = useRouter();
  const { status: bridgeStatus, unlock } = useUnlockedCryptoBridge();
  const [status, setStatus] = useState<Status>({ kind: "checking" });
  const [unlockError, setUnlockError] = useState<string | undefined>(undefined);
  const [unlocking, setUnlocking] = useState(false);

  useEffect(() => {
    if (bridgeStatus.kind !== "ready") return;
    const bridge = bridgeStatus.bridge;
    const ephPubUrlSafe = window.location.hash.slice(1);

    // The CLI mints this fragment with `encodeBase64Url` (falcon-plan.md §2.2
    // — URL-safe, no padding) — a different STRING than the plain-base64
    // `ephPub` the CLI sent when it created the pairing request
    // (`POST /v1/auth/pair`, plain `encodeBase64`). The server identifies a
    // pairing request by that plain-base64 string (`pair.ts`'s `eq(pairRequests.ephPub, ...)`
    // is a string comparison, not a byte comparison), so every downstream
    // call here (sealForPeer, approvePairing) must use the re-encoded plain
    // form, not the URL-safe one, or the server will never find a match.
    const ephPubBytes = ephPubUrlSafe
      ? decodeBase64(ephPubUrlSafe, "base64url")
      : new Uint8Array(0);
    if (ephPubBytes.length !== X25519_PUBLIC_KEY_BYTES) {
      setStatus({ kind: "invalid-link" });
      return;
    }
    const ephPub = encodeBase64(ephPubBytes);

    let cancelled = false;
    (async () => {
      const identity = await bridge.getIdentity();
      if (cancelled) return;

      const gate = await resolvePairGate(identity, { isSignedIn, silentRefresh });
      if (cancelled) return;
      if (gate === "signin") {
        stashPendingPair(ephPub);
        router.replace("/signin/");
        return;
      }
      setStatus({ kind: "confirm", ephPub });
    })();

    return () => {
      cancelled = true;
    };
  }, [bridgeStatus, router]);

  async function handleUnlock(pin: string) {
    setUnlocking(true);
    setUnlockError(undefined);
    const ok = await unlock(pin);
    setUnlocking(false);
    if (!ok) setUnlockError("Wrong PIN. Try again.");
  }

  async function approve(ephPub: string) {
    if (bridgeStatus.kind !== "ready") return;
    const bridge = bridgeStatus.bridge;
    setStatus({ kind: "approving", ephPub });
    let token = getToken();
    if (!token) {
      // Just-in-case retry (known-issues.md #14): `/pair` has its own one-shot
      // gate above rather than `RequireAuth`'s mounted 60s re-check interval,
      // so a token that expired in the gap between that gate and clicking
      // Approve wouldn't otherwise get a chance to refresh.
      token = (await silentRefresh()) ? getToken() : null;
    }
    if (!token) {
      setStatus({
        kind: "error",
        message: "You've been signed out. Please sign in again.",
        ephPub,
      });
      return;
    }
    try {
      // issue-4-plan.md §6.3: mint the new device's session server-side FIRST — the
      // resulting refresh token has to reach the crypto worker so it can be sealed
      // alongside the master secret, not relayed to the server in plaintext.
      const { refreshToken } = await mintPairSession(token, ephPub);
      const sealed = await bridge.sealForPeer(ephPub, refreshToken);
      await approvePairing(token, { ephPub, response: sealed });
      setStatus({ kind: "approved" });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Approval failed. Please retry.";
      setStatus({ kind: "error", message, ephPub });
    }
  }

  if (bridgeStatus.kind === "needs-unlock") {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <PinUnlockForm pending={unlocking} error={unlockError} onSubmit={handleUnlock} />
        </div>
      </main>
    );
  }

  if (bridgeStatus.kind === "no-identity") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          This browser has no Falcon key material for your account yet — sign in with email/password
          or OAuth first, then reopen this pairing link.
        </p>
        <Button type="button" variant="outline" onClick={() => router.push("/reset-keys/")}>
          Reset keys for this browser
        </Button>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8 text-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Device pairing</h1>
      </div>

      {status.kind === "checking" && (
        <p className="text-sm text-muted-foreground">Checking pairing link…</p>
      )}

      {status.kind === "invalid-link" && (
        <p className="max-w-sm text-sm text-destructive">
          This pairing link is invalid or malformed. Ask the device to generate a new one.
        </p>
      )}

      {status.kind === "confirm" && (
        <div className="flex max-w-sm flex-col items-center gap-4">
          <p className="text-sm text-muted-foreground">
            A new device wants to sign in as you. Only approve this if you just ran{" "}
            <code className="rounded bg-muted px-1 py-0.5">falcon auth login</code> yourself.
          </p>
          <div className="flex gap-3">
            <Button type="button" onClick={() => approve(status.ephPub)}>
              Approve
            </Button>
            <Button type="button" variant="outline" onClick={() => router.replace("/")}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {status.kind === "approving" && <p className="text-sm text-muted-foreground">Approving…</p>}

      {status.kind === "approved" && (
        <p className="max-w-sm text-sm text-muted-foreground">
          Device approved. You can close this tab and return to the new device.
        </p>
      )}

      {status.kind === "error" && (
        <div className="flex max-w-sm flex-col items-center gap-3">
          <p className="text-sm text-destructive">{status.message}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setStatus({ kind: "confirm", ephPub: status.ephPub })}
          >
            Try again
          </Button>
        </div>
      )}
    </main>
  );
}
