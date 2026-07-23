"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PinSetupForm } from "@/components/auth/pin-setup-form";
import { PinUnlockForm } from "@/components/auth/pin-unlock-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import {
  completePasswordSignIn,
  completePasswordSignUp,
  rotateKeyEpoch,
} from "@/lib/complete-password-sign-in";
import { getToken } from "@/lib/session";
import {
  isCryptoBridgeUnlocked,
  markCryptoBridgeUnlocked,
  useCryptoBridge,
} from "@/lib/use-crypto-bridge";

type Mode = "signup" | "signin";

/** After a successful `passwordLogin`, this page's own follow-up steps — separate
 * from the plain email/password form `Status` below, since which of these applies
 * depends on this BROWSER's local key material, not the account itself. */
type PostLoginStep =
  | { kind: "checking" }
  | { kind: "needs-unlock" }
  | { kind: "unlocking"; error?: string }
  | { kind: "needs-rotate" } // no local identity at all — new browser
  | { kind: "rotate-password"; forgotPin?: boolean }
  | { kind: "rotate-pin"; password: string }
  | { kind: "rotating"; error?: string }
  | { kind: "done" };

type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; message: string }
  | { kind: "post-login"; step: PostLoginStep };

/**
 * issue-4-plan.md §5.2/§6.1/§6.3 email+password sign-up/sign-in with PIN key custody —
 * the identity-layer sibling of the OAuth flow at `/signin/`. Sign-up collects a PIN
 * alongside email/password and PIN-wraps the freshly-generated masterSecret
 * (`completePasswordSignUp`). Sign-in, after authenticating, walks this browser's
 * local key-custody state: unlock with the existing PIN, or — if there's no local
 * identity, or the PIN is forgotten — rotate to a brand-new PIN-wrapped identity
 * (fenced server-side by `keys/bind`'s step-up + "other devices online" checks).
 */
export default function PasswordAuthPage() {
  const router = useRouter();
  const bridge = useCryptoBridge();
  const [mode, setMode] = useState<Mode>("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Security review finding F1: `completePasswordSignIn` no longer persists the refresh
  // token itself (it can't — the worker isn't necessarily unlocked yet) — this browser
  // holds onto it just long enough to hand it to `bridge.setRefreshToken`/`rotateKeyEpoch`
  // once the post-login unlock/rotate step below actually has an unlocked worker to
  // PIN-wrap it into. Never written to `localStorage` or any other persistent store.
  const [pendingRefreshToken, setPendingRefreshToken] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!bridge) return;
    // Sign-up's actual submission happens via the PinSetupForm rendered below (it
    // needs the PIN too) — this form's own submit (e.g. pressing Enter in the email
    // field) is a no-op in that mode rather than a confusing half-transition.
    if (mode === "signup") return;
    setStatus({ kind: "pending" });
    try {
      const { nextUrl, refreshToken } = await completePasswordSignIn(email, password);
      setPendingRefreshToken(refreshToken);
      await afterLogin(nextUrl);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Something went wrong. Please retry.";
      setStatus({ kind: "error", message });
    }
  }

  async function handleSignUpPinSubmit(pin: string) {
    if (!bridge) return;
    setStatus({ kind: "pending" });
    try {
      const { nextUrl } = await completePasswordSignUp(bridge, email, password, pin);
      router.replace(nextUrl);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Something went wrong. Please retry.";
      setStatus({ kind: "error", message });
    }
  }

  /** After a successful login, decide what this browser needs before it's usable:
   * unlock (known device), or rotate (no local identity / forgotten PIN). */
  async function afterLogin(nextUrl: string): Promise<void> {
    if (!bridge) return;
    if (isCryptoBridgeUnlocked()) {
      // Already unlocked (e.g. this page loaded once already this session) — the
      // login we just completed still minted a NEW refresh token that supersedes
      // whatever was persisted before.
      if (pendingRefreshToken) await bridge.setRefreshToken(pendingRefreshToken);
      router.replace(nextUrl);
      return;
    }
    const identity = await bridge.getIdentity();
    setStatus({
      kind: "post-login",
      step: identity ? { kind: "needs-unlock" } : { kind: "needs-rotate" },
    });
  }

  async function handleUnlockSubmit(pin: string) {
    if (!bridge) return;
    setStatus({ kind: "post-login", step: { kind: "unlocking" } });
    const ok = await bridge.unlock(pin);
    if (ok) {
      markCryptoBridgeUnlocked();
      if (pendingRefreshToken) await bridge.setRefreshToken(pendingRefreshToken);
      router.replace("/");
      return;
    }
    setStatus({
      kind: "post-login",
      step: { kind: "unlocking", error: "Wrong PIN. Try again." },
    });
  }

  function startRotate(): void {
    setStatus({ kind: "post-login", step: { kind: "rotate-password" } });
  }

  function handleRotatePasswordSubmit(stepUpPassword: string): void {
    setStatus({ kind: "post-login", step: { kind: "rotate-pin", password: stepUpPassword } });
  }

  async function handleRotatePinSubmit(stepUpPassword: string, newPin: string) {
    if (!bridge) return;
    const token = getToken();
    if (!token || !pendingRefreshToken) {
      setStatus({ kind: "error", message: "You've been signed out. Please sign in again." });
      return;
    }
    setStatus({ kind: "post-login", step: { kind: "rotating" } });
    const outcome = await rotateKeyEpoch(bridge, token, pendingRefreshToken, stepUpPassword, newPin);
    if (outcome.kind === "ok") {
      router.replace(outcome.nextUrl);
      return;
    }
    if (outcome.kind === "wrong-password") {
      // Back to the password step, with an inline explanation — a wrong step-up
      // password means whatever new key material `rotateKeyEpoch` just generated
      // locally was NEVER bound server-side, so retrying with the right password is
      // still safe (this browser simply generates another fresh set on the next try).
      setStatus({ kind: "post-login", step: { kind: "rotate-password", forgotPin: true } });
      return;
    }
    setStatus({
      kind: "post-login",
      step: { kind: "rotating", error: outcome.message },
    });
  }

  if (status.kind === "post-login") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
        <Card className="w-full max-w-sm border border-border/60 bg-card/95 shadow-sm">
          <CardHeader>
            <CardTitle>
              {status.step.kind === "needs-rotate" || status.step.kind.startsWith("rotate")
                ? "Set up this device"
                : "Unlock this device"}
            </CardTitle>
            <CardDescription>issue-4-plan.md §6.1/§6.4 PIN key custody.</CardDescription>
          </CardHeader>
          <CardContent>
            {status.step.kind === "checking" && (
              <p className="text-sm text-muted-foreground">Please wait…</p>
            )}
            {status.step.kind === "rotating" && !status.step.error && (
              <p className="text-sm text-muted-foreground">Rotating your keys…</p>
            )}
            {status.step.kind === "rotating" && status.step.error && (
              <div className="space-y-4">
                <p className="text-sm text-destructive" aria-live="polite">
                  {status.step.error}
                </p>
                <Button type="button" variant="outline" className="w-full" onClick={startRotate}>
                  Try again
                </Button>
              </div>
            )}
            {(status.step.kind === "needs-unlock" || status.step.kind === "unlocking") && (
              <PinUnlockForm
                pending={status.step.kind === "unlocking"}
                error={status.step.kind === "unlocking" ? status.step.error : undefined}
                onSubmit={handleUnlockSubmit}
                onForgotPin={startRotate}
              />
            )}
            {status.step.kind === "needs-rotate" && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  This browser has no key material for your account yet. Generate a new set (this
                  signs every OTHER device out, unless one of them approves a pairing instead).
                </p>
                <Button type="button" className="w-full" onClick={startRotate}>
                  Generate new keys
                </Button>
              </div>
            )}
            {status.step.kind === "rotate-password" && (
              <RotatePasswordStep
                forgotPin={status.step.forgotPin}
                onSubmit={handleRotatePasswordSubmit}
              />
            )}
            {status.step.kind === "rotate-pin" && (
              <RotatePinStep
                stepUpPassword={status.step.password}
                onSubmit={handleRotatePinSubmit}
              />
            )}
          </CardContent>
        </Card>
      </main>
    );
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

            {mode === "signin" && (
              <Button
                type="submit"
                className="w-full"
                disabled={status.kind === "pending" || !bridge}
              >
                {status.kind === "pending" ? "Please wait…" : "Sign in"}
              </Button>
            )}
          </form>

          {mode === "signup" && (
            <div className="mt-4">
              <PinSetupForm pending={status.kind === "pending"} onSubmit={handleSignUpPinSubmit} />
            </div>
          )}

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

function RotatePinStep({
  stepUpPassword,
  onSubmit,
}: {
  stepUpPassword: string;
  onSubmit: (stepUpPassword: string, newPin: string) => void;
}) {
  return <PinSetupForm onSubmit={(pin) => onSubmit(stepUpPassword, pin)} />;
}

function RotatePasswordStep({
  forgotPin,
  onSubmit,
}: {
  forgotPin?: boolean;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (password) onSubmit(password);
      }}
    >
      <p className="text-sm text-muted-foreground">
        {forgotPin
          ? "That PIN was wrong on the previous attempt. Re-enter your account password to prove it's you before generating new keys."
          : "Re-enter your account password to prove it's you before generating new keys."}
      </p>
      <Input
        type="password"
        autoComplete="current-password"
        placeholder="Account password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Button type="submit" className="w-full" disabled={password.length === 0}>
        Continue
      </Button>
    </form>
  );
}
