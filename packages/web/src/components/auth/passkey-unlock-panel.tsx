"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { discoverPasskey } from "@/crypto";
import { keysBind, keysChallenge } from "@/lib/api";
import { getToken } from "@/lib/session";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";

interface Props {
  accountId: string;
  onReady: () => void;
  onFallback: () => void;
}

type State = "idle" | "working" | "error";

export function PasskeyUnlockPanel({ accountId, onReady, onFallback }: Props) {
  const bridge = useCryptoBridge();
  const [state, setState] = useState<State>("idle");

  async function handleUnlock() {
    if (!bridge) return;
    setState("working");

    const result = await discoverPasskey(accountId);
    if (!result) {
      setState("error");
      return;
    }

    const claimed = await bridge.claimPasskey(accountId, result.masterSecret, result.credentialId);
    if (!claimed) {
      setState("error");
      return;
    }

    const token = getToken();
    if (!token) {
      setState("error");
      return;
    }

    try {
      const { nonce } = await keysChallenge(token);
      const proof = await bridge.bindKeysProof(accountId, nonce);
      await keysBind(token, {
        signPubKey: proof.signPubKey,
        contentPubKey: proof.contentPubKey,
        nonce,
        signature: proof.signature,
      });
    } catch {
      await bridge.clear();
      setState("error");
      return;
    }

    onReady();
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-4 text-left">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">One more step</h2>
        <p className="text-sm text-muted-foreground">
          Your encryption key is protected by a passkey. Use Face ID, Touch ID, or your device
          passkey to unlock.
        </p>
      </div>

      <Button onClick={() => void handleUnlock()} disabled={state === "working"}>
        {state === "working" ? "Unlocking..." : "Unlock with Face ID / Passkey"}
      </Button>

      {state === "error" && (
        <p className="text-sm text-muted-foreground">
          Could not unlock. If you don&apos;t have your passkey on this device,{" "}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={onFallback}
          >
            get a copy from another device
          </button>
          .
        </p>
      )}

      <button
        type="button"
        className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={onFallback}
      >
        Use another device instead
      </button>
    </div>
  );
}
