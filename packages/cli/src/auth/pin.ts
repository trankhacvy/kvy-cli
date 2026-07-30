/**
 * PIN unwrapping for reading credentials written by an older `falcon` build
 * (issue-4-plan.md §6.1/§6.5, revised): `falcon auth login` no longer writes PIN-wrapped
 * credentials — see `keyMaterial.ts` — but a machine that paired before that change may
 * still have a `"pin"`-mode `access.key` on disk, and this lets that credential still
 * unlock rather than forcing a re-login. Uses the same `unwrapWithPin` (`@falcon/crypto`)
 * the web client uses (same argon2id params, `pin-params.ts`). Mirrors
 * `shim/onboardingPrompt.ts`'s `node:readline/promises` + injectable-prompt pattern so
 * this is unit-testable without a real TTY.
 */
import { createInterface } from "node:readline/promises";
import type { PinWrapped } from "@falcon/crypto";
import { unwrapWithPin } from "@falcon/crypto";

const MAX_UNLOCK_ATTEMPTS = 3;

export interface PinPromptDeps {
  /** Test seam; defaults to a real masked-ish `readline` prompt (no echo suppression —
   * documented gap, see the module docblock's "not implemented" note below). */
  prompt?: (question: string) => Promise<string>;
  write?: (text: string) => void;
}

async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Prompts for the PIN that unwraps an already-provisioned `wrapped` blob, retrying up
 * to `MAX_UNLOCK_ATTEMPTS` times on a wrong PIN before giving up (`null`) — a bounded
 * retry, not an infinite loop, so a scripted/non-interactive caller (or a genuinely
 * forgotten PIN) fails fast instead of hanging.
 */
export async function promptAndUnwrapWithPin(
  wrapped: PinWrapped,
  deps: PinPromptDeps = {},
): Promise<Uint8Array | null> {
  const prompt = deps.prompt ?? defaultPrompt;
  const write = deps.write ?? ((text: string) => process.stdout.write(text));

  for (let attempt = 1; attempt <= MAX_UNLOCK_ATTEMPTS; attempt++) {
    const pin = (await prompt("Enter your PIN: ")).trim();
    const secret = await unwrapWithPin(wrapped, pin);
    if (secret) return secret;
    if (attempt < MAX_UNLOCK_ATTEMPTS) write("Wrong PIN. Try again.\n");
  }
  return null;
}
