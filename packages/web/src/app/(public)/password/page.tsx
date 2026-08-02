"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { KeyProtectionChoice } from "@/components/auth/key-protection-choice";
import { RequestKeysPanel } from "@/components/auth/request-keys-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { type KeyWrapMode, provisionKeyProtection } from "@/crypto";
import { ApiError } from "@/lib/api";
import { completePasswordSignIn, completePasswordSignUp } from "@/lib/complete-password-sign-in";
import { copy } from "@/lib/copy";
import { peekPendingPair } from "@/lib/pending-pair";
import { getAccountId } from "@/lib/session";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";

type Mode = "signup" | "signin";

type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; message: string }
  | { kind: "info"; message: string }
  /** Sign-up on a brand-new browser: pick how keys are protected, then provision. */
  | { kind: "choose-protection" }
  /** Signed in, but this browser has no keys — fetch them from another device. */
  | { kind: "needs-keys"; nextUrl: string };

/** Email + password sign-up/sign-in for local testing (404 in production). Sign-up asks
 * once how this browser should protect keys at rest; sign-in loads them silently or, on a
 * browser without keys, offers to fetch them from another device. */
export default function PasswordAuthPage() {
  const router = useRouter();
  const bridge = useCryptoBridge();
  const [mode, setMode] = useState<Mode>("signup");
  const [pendingPair, setPendingPair] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Read in an EFFECT, not a `useState` initialiser: `peekPendingPair` dereferences
  // `window.sessionStorage` unguarded, and an initialiser runs during static-export prerender
  // where there is no `window`. `peek` does NOT consume the value; the auth call spends it
  // via `consumePendingPair()`.
  useEffect(() => {
    if (peekPendingPair()) {
      setMode("signin");
      setPendingPair(true);
    }
  }, []);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!bridge) return;
    if (mode === "signup") {
      setStatus({ kind: "choose-protection" });
      return;
    }

    setStatus({ kind: "pending" });
    try {
      const { nextUrl, refreshToken } = await completePasswordSignIn(email, password);
      // Persisting needs no key material now, so this always lands.
      await bridge.setRefreshToken(refreshToken);
      // Scope the identity check to this account specifically, not any record in this browser.
      const identity = await bridge.getIdentity(getAccountId() ?? undefined);
      if (!identity) {
        setStatus({ kind: "needs-keys", nextUrl });
        return;
      }
      router.replace(nextUrl);
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof ApiError ? err.message : "Something went wrong. Please retry.",
      });
    }
  }

  async function handleProtectionChoice(keyMode: KeyWrapMode): Promise<void> {
    if (!bridge) return;
    setStatus({ kind: "pending" });
    try {
      const protection = await provisionKeyProtection(keyMode, email);
      const outcome = await completePasswordSignUp(bridge, email, password, protection);
      if (outcome.kind === "existing-account") {
        // The server returns the same generic success shape for an already-registered
        // email (no enumeration), so there's no session or key material to set up here.
        setMode("signin");
        setStatus({
          kind: "info",
          message:
            "Check your inbox for next steps, or sign in below if you already have an account.",
        });
        return;
      }
      router.replace(outcome.nextUrl);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setStatus({ kind: "needs-keys", nextUrl: "/dashboard/" });
        return;
      }
      setStatus({
        kind: "error",
        message: err instanceof ApiError ? err.message : "Something went wrong. Please retry.",
      });
    }
  }

  if (status.kind === "choose-protection") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-8">
        <KeyProtectionChoice onChoose={(keyMode) => void handleProtectionChoice(keyMode)} />
      </main>
    );
  }

  if (status.kind === "needs-keys") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-8">
        <RequestKeysPanel onReady={() => router.replace(status.nextUrl)} />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <Card className="w-full max-w-sm border border-border/60 bg-card/95 shadow-sm">
        <CardHeader>
          <CardTitle>
            {mode === "signin" && pendingPair
              ? copy.signin.titleWithPendingPair
              : mode === "signup"
                ? "Create your account"
                : "Sign in"}
          </CardTitle>
          <CardDescription>Email + password sign-in for local testing.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <Input
                id="password"
                type="password"
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                required
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            {status.kind === "error" && (
              <p className="text-sm text-destructive" aria-live="polite">
                {status.message}
              </p>
            )}

            {status.kind === "info" && (
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {status.message}
              </p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={status.kind === "pending" || !bridge}
            >
              {status.kind === "pending"
                ? "Please wait…"
                : mode === "signup"
                  ? "Create account"
                  : "Sign in"}
            </Button>
          </form>

          <Button
            type="button"
            variant="link"
            className="mt-2 w-full"
            onClick={() => {
              setMode(mode === "signup" ? "signin" : "signup");
              setStatus({ kind: "idle" });
            }}
          >
            {mode === "signup" ? "Already have an account? Sign in" : "Need an account? Sign up"}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
