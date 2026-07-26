import type { BridgeStatus } from "@/lib/use-crypto-bridge-status";

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
  deps: {
    isSignedIn: () => boolean;
    silentRefresh: () => Promise<"ok" | "signed-out" | "unreachable">;
  },
): Promise<"confirm" | "signin"> {
  if (!identity) return "signin";
  if (deps.isSignedIn()) return "confirm";
  const result = await deps.silentRefresh();
  return result === "ok" ? "confirm" : "signin";
}

/** `page.tsx`'s screen state machine — exported from here, not `page.tsx`, for the same
 * "a page file may only export the default component" reason `resolvePairGate` is. */
export type Gate =
  | { kind: "checking" }
  | { kind: "invalid-link" }
  | { kind: "needs-keys"; ephPub: string }
  | {
      kind: "confirm";
      ephPub: string;
      label: string | null;
      cwd: string | null;
      requestedAt: string | null;
    }
  | { kind: "approving"; ephPub: string }
  | { kind: "approved"; label: string | null }
  | { kind: "error"; message: string; ephPub: string };

/** The fields `fetchPairDetails` resolves, hoisted out of the `confirm` gate so they
 * survive the `needs-keys` detour (see `nextGate` below) instead of being lost when the
 * gate demotes to `needs-keys`, which keeps only `ephPub`. */
export interface PairDetails {
  label: string | null;
  cwd: string | null;
  requestedAt: string | null;
}

/**
 * auth-ux-overhaul-fix-plan.md Fix 10: the crypto-readiness effect used to only ever
 * DEMOTE `confirm` -> `needs-keys` when the bridge reported no keys, with no inverse — so
 * a user who fetched their keys via `RequestKeysPanel` was left staring at the key-request
 * screen they'd just finished, with the CLI still waiting. This is the reversible version:
 * both arms are guarded on the CURRENT gate kind, so a browser that flickers
 * `ready -> no-keys -> ready` can't bounce the user between screens.
 */
export function nextGate(
  current: Gate,
  bridgeStatusKind: BridgeStatus["kind"],
  details: PairDetails | null,
): Gate {
  if (bridgeStatusKind === "no-keys" && current.kind === "confirm") {
    return { kind: "needs-keys", ephPub: current.ephPub };
  }
  if (bridgeStatusKind === "ready" && current.kind === "needs-keys") {
    return {
      kind: "confirm",
      ephPub: current.ephPub,
      label: details?.label ?? null,
      cwd: details?.cwd ?? null,
      requestedAt: details?.requestedAt ?? null,
    };
  }
  return current;
}
