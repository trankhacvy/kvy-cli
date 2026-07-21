/**
 * Owns the "restore from recovery code" flow's status transitions
 * (`page.tsx` owns only rendering + `router.replace`, mirroring the split
 * between `restore-recovery-code.ts` and its callers). Kept independent of
 * the page's top-level `Status` union: a restore attempt shouldn't unmount
 * `needs-signup`'s OAuth buttons or the recovery-code input — a failure
 * renders as a small inline message alongside them, not a full status-branch
 * swap.
 */
import type { CryptoBridgeClient } from "@/crypto";
import { restoreRecoveryCode } from "@/lib/restore-recovery-code";

export type RestoreStatus =
  | { kind: "idle" }
  | { kind: "restoring" }
  | { kind: "error"; message: string };

export async function handleRestoreFromRecoveryCode(
  bridge: CryptoBridgeClient,
  code: string,
  callbacks: {
    setRestoreStatus: (status: RestoreStatus) => void;
    onSuccess: (nextUrl: string) => void;
  },
): Promise<void> {
  callbacks.setRestoreStatus({ kind: "restoring" });

  const outcome = await restoreRecoveryCode(bridge, code);

  if (outcome.kind === "ok") {
    callbacks.onSuccess(outcome.nextUrl);
    return;
  }

  callbacks.setRestoreStatus({ kind: "error", message: outcome.message });
}
