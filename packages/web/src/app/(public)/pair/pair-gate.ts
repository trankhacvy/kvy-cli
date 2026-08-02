import type { BridgeStatus } from "@/lib/use-crypto-bridge-status";

/** The pairing gate's actual decision, extracted to its own module because a Next.js
 * `page.tsx` may only export the default component plus metadata fields — a named export
 * like this one fails the build.
 *
 * No local identity bounces immediately; a signed-out-looking visitor gets one
 * `silentRefresh()` attempt — this link is always opened via a full navigation which
 * wipes the in-memory access token, so a valid refresh token would otherwise always
 * bounce. */
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

/** `page.tsx`'s screen state machine — exported here for the same Next.js named-export
 * constraint as `resolvePairGate`. */
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

/** Fields from `fetchPairDetails`, hoisted out of the `confirm` gate so they survive the
 * `needs-keys` detour instead of being lost when the gate demotes to `needs-keys`. */
export interface PairDetails {
  label: string | null;
  cwd: string | null;
  requestedAt: string | null;
}

/**
 * Reversible gate transition: both arms are guarded on the CURRENT gate kind, so a
 * browser that flickers `ready -> no-keys -> ready` can't bounce the user between screens.
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
