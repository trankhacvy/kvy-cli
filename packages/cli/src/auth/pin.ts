/**
 * `kvy auth login` no longer writes PIN-wrapped credentials, but credentials written by
 * an older build may still have `"pin"` mode — this lets those still unlock rather than
 * forcing a re-login. Uses an injectable prompt for testability without a real TTY.
 */
import { createInterface } from "node:readline/promises";
import type { PinWrapped } from "@kvy/crypto";
import { unwrapWithPin } from "@kvy/crypto";

const MAX_UNLOCK_ATTEMPTS = 3;

export interface PinPromptDeps {
  /** Test seam; defaults to a real readline prompt (no echo suppression —
   * readline doesn't hide typed characters by default). */
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
 * Prompts for the PIN, retrying up to `MAX_UNLOCK_ATTEMPTS` times — bounded so a
 * scripted caller or genuinely forgotten PIN fails fast instead of hanging.
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
