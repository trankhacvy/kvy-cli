"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { completePasswordSignIn, completePasswordSignUp } from "@/lib/complete-password-sign-in";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";

type Mode = "signup" | "signin";
type Status = { kind: "idle" } | { kind: "pending" } | { kind: "error"; message: string };

/**
 * issue-4-plan.md §5.2/§6.3 email+password sign-up/sign-in — the identity-layer sibling
 * of the OAuth flow at `/signin/`. Deliberately plain (no PIN step — not implemented in
 * this pass, see docs/issue-4-plan.md's Phase 3/5 notes); this page exists to make the
 * new password/keys-bind/refresh-token routes reachable and testable end-to-end, not as
 * a finished product surface.
 */
export default function PasswordAuthPage() {
  const router = useRouter();
  const bridge = useCryptoBridge();
  const [mode, setMode] = useState<Mode>("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!bridge) return;
    setStatus({ kind: "pending" });
    try {
      const { nextUrl } =
        mode === "signup"
          ? await completePasswordSignUp(bridge, email, password)
          : await completePasswordSignIn(email, password);
      router.replace(nextUrl);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Something went wrong. Please retry.";
      setStatus({ kind: "error", message });
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <Card className="w-full max-w-sm border border-border/60 bg-card/95 shadow-sm">
        <CardHeader>
          <CardTitle>{mode === "signup" ? "Create your account" : "Sign in"}</CardTitle>
          <CardDescription>Email + password (issue-4-plan.md §5.2).</CardDescription>
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
                onChange={(e) => setEmail(e.target.value)}
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
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {status.kind === "error" && (
              <p className="text-sm text-destructive" aria-live="polite">
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
            onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
          >
            {mode === "signup" ? "Already have an account? Sign in" : "Need an account? Sign up"}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
