/**
 * Formats a page-level decrypt failure (W1.10, plan.md §16 wave 1) for
 * display in `SessionTimelineScreen`'s banner. Pulled out of
 * `use-live-render-items.ts`'s catch block so the message-shaping logic is
 * unit-testable without mounting the hook (this package has no DOM test
 * environment for that — see `__tests__/decrypt-error.test.ts`).
 */
export function formatDecryptError(err: unknown): string {
  return err instanceof Error && err.message
    ? err.message
    : "Failed to decrypt this session's messages.";
}
