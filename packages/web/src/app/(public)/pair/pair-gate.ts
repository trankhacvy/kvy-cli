/** The pairing gate's actual decision, pulled out of `page.tsx`'s effect into
 * its own module (a Next.js `page.tsx` may only export the default component
 * plus a handful of known metadata fields — a named export like this one
 * fails the build) so it's testable without mounting React/next/navigation
 * (this package has no DOM test environment — same technique as
 * `require-auth.tsx`'s `shouldRedirectToSignin`).
 *
 * Mirrors `require-auth.tsx`'s `ensureSession`: no local identity bounces
 * immediately (nothing to refresh a session from); a signed-out-looking
 * visitor gets one `silentRefresh()` attempt — this link is *always* opened
 * via a full navigation (new tab, scanned QR, pasted URL), which wipes the
 * in-memory access token by design (`session.ts`), so a perfectly valid,
 * still-unexpired refresh token would otherwise bounce every single time
 * (known-issues.md #14) — and only bounces if that also fails. */
export async function resolvePairGate(
  identity: unknown,
  deps: { isSignedIn: () => boolean; silentRefresh: () => Promise<boolean> },
): Promise<"confirm" | "signin"> {
  if (!identity) return "signin";
  if (deps.isSignedIn()) return "confirm";
  const refreshed = await deps.silentRefresh();
  return refreshed ? "confirm" : "signin";
}
