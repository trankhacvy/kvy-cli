/**
 * Whether a query string carries `RequireAuth`'s `SIGNIN_EXPIRED_PATH` reason.
 * Pulled out of `page.tsx`'s effect into
 * its own module — a Next.js `page.tsx` may only export the default component
 * plus a handful of known metadata fields, so a named export like this one fails
 * the build (see `pair-gate.ts`'s identical reasoning) — so it's testable without
 * mounting React (this package has no DOM test environment; same technique as
 * `require-auth.tsx`'s `shouldRedirectToSignin`).
 */
export function isExpiredReason(search: string): boolean {
  return new URLSearchParams(search).get("reason") === "expired";
}
