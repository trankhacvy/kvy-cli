/**
 * PIN prompting for the CLI's interactive-foreground credential mode
 * (issue-4-plan.md §6.1/§6.5): `falcon auth login` run at a real terminal PIN-wraps the
 * masterSecret with a PIN the user types, the same `wrapWithPin`/`unwrapWithPin`
 * (`@falcon/crypto`) the web client uses — a wrapped blob is byte-portable between the
 * two (same argon2id params, `pin-params.ts`). Mirrors `shim/onboardingPrompt.ts`'s
 * `node:readline/promises` + injectable-prompt pattern so this is unit-testable without
 * a real TTY.
 */
import { createInterface } from "node:readline/promises";
import type { PinWrapped } from "@falcon/crypto";
import { unwrapWithPin, wrapWithPin } from "@falcon/crypto";

const MIN_PIN_LENGTH = 6;
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
 * Prompts for a brand-new PIN (with confirmation) and wraps `secret` under it.
 * Retries on a too-short PIN or a confirmation mismatch rather than silently accepting
 * a weak/mistyped one — there's no server-side recovery for a lost PIN short of the
 * rotate-epoch flow (issue-4-plan.md §6.2), so getting it right at set-time matters.
 *
 * **Known gap**: this reads the PIN as plain visible input — `node:readline` has no
 * built-in masked-input mode, and adding raw-mode character-by-character echo
 * suppression was cut from this pass (docs/issue-4-plan.md's Phase 5 checklist).
 */
export async function promptAndWrapWithPin(
  secret: Uint8Array,
  deps: PinPromptDeps = {},
): Promise<{ pin: string; wrapped: PinWrapped }> {
  const prompt = deps.prompt ?? defaultPrompt;
  const write = deps.write ?? ((text: string) => process.stdout.write(text));

  for (;;) {
    const pin = (await prompt(`Create a PIN (at least ${MIN_PIN_LENGTH} characters): `)).trim();
    if (pin.length < MIN_PIN_LENGTH) {
      write(`PIN must be at least ${MIN_PIN_LENGTH} characters.\n`);
      continue;
    }
    const confirmation = (await prompt("Confirm PIN: ")).trim();
    if (confirmation !== pin) {
      write("PINs didn't match — try again.\n");
      continue;
    }
    const wrapped = await wrapWithPin(secret, pin);
    return { pin, wrapped };
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
    if (attempt < MAX_UNLOCK_ATTEMPTS) write("Wrong PIN — try again.\n");
  }
  return null;
}
