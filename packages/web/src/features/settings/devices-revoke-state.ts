/**
 * `DevicesSection`'s inline revoke-confirm gate (docs/auth-ux-hardening-plan.md
 * item 5), kept as pure functions so the request -> confirm/cancel transitions
 * are directly unit-testable without mounting the component — same precedent
 * as `features/git-diff/git-toolbar-state.ts` / `features/unmanaged-sessions/
 * take-over-dialog-state.ts` (this package's vitest config has no jsdom/
 * `@testing-library/react` wired up, so a real click can't be simulated here
 * — see `git-toolbar-state.ts`'s own doc comment on the same constraint).
 */

/** The id of the device session row currently showing the inline
 * "Confirm / Cancel" affordance, or `null` when every row shows its plain
 * "Log out" trigger. */
export type RevokeConfirmId = string | null;

/** First click on a row's "Log out" trigger — requests confirmation for
 * that row without revoking anything yet. */
export function requestRevoke(sessionId: string): RevokeConfirmId {
  return sessionId;
}

/** Returns to "no row confirming" — used both by "Cancel" (no revoke sent)
 * and by a successful "Confirm" click (the caller clears this right before
 * firing the real revoke, so the affordance doesn't linger while it's
 * pending). */
export function clearRevokeConfirm(): RevokeConfirmId {
  return null;
}

/** The confirm gate itself: a "Confirm" click may only proceed to the real
 * `revokeSession` API call for the exact row that's currently confirming —
 * this is what makes revoking a session require a second click. */
export function canConfirmRevoke(confirmId: RevokeConfirmId, sessionId: string): boolean {
  return confirmId === sessionId;
}
