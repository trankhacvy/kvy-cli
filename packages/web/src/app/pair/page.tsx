"use client";

import { decodeBase64 } from "@falcon/crypto/web";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, approvePairing } from "@/lib/api";
import { stashPendingPair } from "@/lib/pending-pair";
import { getToken, isSignedIn } from "@/lib/session";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";

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
export default function PairPage() {
  const router = useRouter();
  const bridge = useCryptoBridge();
  const [status, setStatus] = useState<Status>({ kind: "checking" });

  useEffect(() => {
    if (!bridge) return;
    const ephPub = window.location.hash.slice(1);

    if (!ephPub || decodeBase64(ephPub).length !== X25519_PUBLIC_KEY_BYTES) {
      setStatus({ kind: "invalid-link" });
      return;
    }

    let cancelled = false;
    (async () => {
      const identity = await bridge.getIdentity();
      if (cancelled) return;

      if (!identity || !isSignedIn()) {
        stashPendingPair(ephPub);
        router.replace("/signin/");
        return;
      }
      setStatus({ kind: "confirm", ephPub });
    })();

    return () => {
      cancelled = true;
    };
  }, [bridge, router]);

  async function approve(ephPub: string) {
    if (!bridge) return;
    setStatus({ kind: "approving", ephPub });
    const token = getToken();
    if (!token) {
      setStatus({ kind: "error", message: "You've been signed out. Please sign in again.", ephPub });
      return;
    }
    try {
      const sealed = await bridge.sealForPeer(ephPub);
      await approvePairing(token, { ephPub, response: sealed });
      setStatus({ kind: "approved" });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Approval failed. Please retry.";
      setStatus({ kind: "error", message, ephPub });
    }
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

      {status.kind === "approving" && (
        <p className="text-sm text-muted-foreground">Approving…</p>
      )}

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
