"use client";

import { useEffect, useState } from "react";
import { GithubIcon } from "@/components/icons/github";
import { GoogleIcon } from "@/components/icons/google";
import { listDeviceSessions } from "@/lib/api";
import { copy } from "@/lib/copy";
import { getToken } from "@/lib/session";

type IdentityKind = "password" | "google" | "github" | null;

const PROVIDER_LABEL: Record<Exclude<IdentityKind, null>, string> = {
  password: "email and password",
  google: "Google",
  github: "GitHub",
};

function ProviderIcon({ kind }: { kind: IdentityKind }) {
  if (kind === "google") return <GoogleIcon className="size-5" />;
  if (kind === "github") return <GithubIcon className="size-5" />;
  return null;
}

export function AccountSection() {
  const [email, setEmail] = useState<string | null>(null);
  const [identityKind, setIdentityKind] = useState<IdentityKind>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const token = getToken();
    if (!token) return;
    listDeviceSessions(token)
      .then((result) => {
        if (cancelled) return;
        setEmail(result.email);
        setIdentityKind(result.identityKind);
        setCreatedAt(result.accountCreatedAt);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load account");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {!error && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <div className="flex items-center gap-3">
            <ProviderIcon kind={identityKind} />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {identityKind
                  ? copy.account.signedInWith(PROVIDER_LABEL[identityKind])
                  : "Signed in"}
              </p>
              {email && <p className="truncate text-sm text-muted-foreground">{email}</p>}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{copy.account.identityExplainer}</p>
        </div>
      )}

      {createdAt && (
        <p className="text-sm text-muted-foreground">
          {copy.account.createdOn(
            new Date(createdAt).toLocaleDateString(undefined, {
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
          )}
        </p>
      )}
    </div>
  );
}
