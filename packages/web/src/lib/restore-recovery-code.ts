/**
 * Recovery-code restore (docs/bug-fix-plan.md #12 "recovery-code-restore",
 * known-issues.md "Recovery code can silently create a disconnected account
 * instead of failing", design §5.1 "Recovery"): a wiped/new browser can
 * restore its *original* identity from a previously-exported recovery code
 * instead of provisioning a brand-new one. Pulled out of `signin/page.tsx`
 * as its own pure async function, same shape as
 * `complete-challenge-sign-in.ts`/`complete-oauth-sign-in.ts` — the page
 * component owns only `setStatus`/`router.replace` wiring; this owns the
 * actual decode -> init -> sign-in sequence so it can be unit-tested with a
 * fake `CryptoBridgeClient` and no DOM/rendering involved (this package's
 * vitest config runs with `environment: "node"`, no jsdom/@testing-library).
 *
 * This module was originally attempted on parked branch `wf/BF3.2` and
 * explicitly held back in review: `decodeRecoveryCode` had no checksum tying
 * a code to a real account, and `/v1/auth` couldn't distinguish "found" from
 * "created" — so a wrong-but-well-formed code silently minted a fresh,
 * disconnected account instead of failing (see `packages/crypto/src/
 * recovery.ts`'s CHECKSUM note and `packages/server/src/app/routes/auth.ts`'s
 * ACCOUNT STATUS note — both now fixed). This is a from-scratch
 * reimplementation adapted to the current sign-in page (which has since been
 * redesigned) and to those two now-real capabilities, rather than a
 * cherry-pick of BF3.2's commits: BF3.2's `signin/page.tsx` no longer exists
 * in its original shape (route-group auth shell + AI Elements chat UI landed
 * afterward), so its diff doesn't apply cleanly. The decode -> init ->
 * sign-in -> rollback-on-failure shape below matches BF3.2's design (down to
 * the "roll back `bridge.init`'s persisted identity via `bridge.clear()` on
 * any failure" fix from its own review pass), plus the one behavior BF3.2's
 * review explicitly flagged as unbuildable at the time: a well-formed code
 * whose sign-in succeeds but whose `accountStatus` is `"created"` (not
 * `"found"`) is now also rolled back and reported as "no account found",
 * rather than being accepted as if the restore had actually worked.
 */
import { decodeRecoveryCode } from "@falcon/crypto/web";
import type { CryptoBridgeClient } from "@/crypto";
import { completeChallengeSignIn } from "./complete-challenge-sign-in.js";

export type RestoreRecoveryCodeOutcome =
  | { kind: "ok"; nextUrl: string }
  | { kind: "invalid-code"; message: string }
  | { kind: "no-account-found"; message: string }
  | { kind: "sign-in-failed"; message: string };

const INVALID_CODE_MESSAGE = "That recovery code doesn't look right. Check it and try again.";
const NO_ACCOUNT_MESSAGE = "No account found for that recovery code.";
const GENERIC_FAILURE_MESSAGE = "Restore failed. Please retry.";

/**
 * Decodes `code` back to a masterSecret and, if well-formed (checksum
 * verified — see `@falcon/crypto`'s `decodeRecoveryCode`), provisions the
 * worker with it (`bridge.init`) and completes the same returning-device
 * challenge sign-in the trusted-device path already uses.
 *
 * - A malformed/garbled code returns `invalid-code` before touching `bridge`
 *   at all — no side effects, no network call, for garbage input.
 * - A well-formed code whose sign-in reports `accountStatus: "created"` means
 *   this exact identity had no matching account server-side (a
 *   well-formed-looking but never-issued code — the exact bug this module
 *   exists to close) — the just-persisted identity is rolled back via
 *   `bridge.clear()` and `no-account-found` is reported, so no new,
 *   disconnected account is left standing.
 * - Any other sign-in failure (bad signature — unreachable in practice since
 *   the worker signs its own freshly-decoded key; rate limit; transient
 *   network/5xx) is also rolled back and reported as the generic
 *   `sign-in-failed`.
 */
export async function restoreRecoveryCode(
  bridge: CryptoBridgeClient,
  code: string,
): Promise<RestoreRecoveryCodeOutcome> {
  const masterSecret = decodeRecoveryCode(code);
  if (!masterSecret) {
    return { kind: "invalid-code", message: INVALID_CODE_MESSAGE };
  }

  await bridge.init(masterSecret);

  // `bridge.init` above already persisted the recovered identity to
  // IndexedDB. Whether sign-in failed outright or "succeeded" against a
  // freshly-created (i.e. wrong) account, that persisted identity must not
  // survive a failed restore -- otherwise this browser is left holding a
  // wrong/unconfirmed identity, and a later reload of /signin/ would see a
  // non-null `getIdentity()` and walk straight back into the same failing
  // (or silently-wrong) trusted-device sign-in, with no way back to
  // needs-signup's OAuth buttons or the recovery-code input short of
  // clearing browser storage by hand.
  const rollback = async (): Promise<void> => {
    try {
      await bridge.clear();
    } catch {
      // best-effort rollback; the caller's own failure report takes priority
    }
  };

  try {
    const { nextUrl, accountStatus } = await completeChallengeSignIn(bridge);

    if (accountStatus === "created") {
      // This masterSecret decoded fine (checksum passed) but doesn't match any
      // real account — the upsert in `/v1/auth` just created a brand-new one.
      // Undo that: a restore either finds the real account or leaves no trace.
      await rollback();
      return { kind: "no-account-found", message: NO_ACCOUNT_MESSAGE };
    }

    return { kind: "ok", nextUrl };
  } catch {
    await rollback();
    return { kind: "sign-in-failed", message: GENERIC_FAILURE_MESSAGE };
  }
}
