/**
 * Fixture-prompt corpus for the provider contract test
 * (`scripts/provider-contract-test.ts`, kvy-system-design.md §13 item 2).
 *
 * Kept deliberately small and tool-free: the point of this suite is to
 * check the *shape* Claude Code writes things in (transcript JSONL fields,
 * hook events, `--resume` continuity), not to exercise the product's own
 * tool-permission pipeline (that's `permissionHandler.test.ts`'s job,
 * against a fake SDK). Every prompt asks for a single fixed word and
 * explicitly says not to use tools, so a real run is fast, cheap, and its
 * assistant-turn content is trivially deterministic to eyeball in CI logs
 * if something looks off.
 *
 * `resumeFrom` marks a fixture that must be run as a follow-up turn in the
 * *same* provider session as the fixture before it (via `--resume`), rather
 * than a fresh session — this is what exercises the resume-continuity half
 * of the contract (design §13 item 2: "resume behavior").
 */

export interface ContractFixturePrompt {
  /** Short identifier used in CI log output only. */
  name: string;
  /** The literal prompt text passed to `claude -p`. */
  prompt: string;
  /** When true, this fixture resumes the immediately preceding one's session instead of starting fresh. */
  resumeFrom?: boolean;
}

export const FIXTURE_PROMPTS: ContractFixturePrompt[] = [
  {
    name: "hello-world",
    prompt: "Reply with exactly the single word PONG and nothing else. Do not use any tools.",
  },
  {
    name: "resume-follow-up",
    prompt:
      "This is a follow-up message in the same conversation. Reply with exactly the single word PONG2 and nothing else. Do not use any tools.",
    resumeFrom: true,
  },
];
