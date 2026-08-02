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
