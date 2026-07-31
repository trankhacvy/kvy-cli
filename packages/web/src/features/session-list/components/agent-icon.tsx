/**
 * Maps a session's raw `provider` string (`SessionRow.provider` — a free
 * string, no wire-level enum: `"claude-code"`/`"codex"` are the two real
 * values sessions are created with today, `packages/cli/src/commands/
 * start.ts:568`/`startCodex.ts:200`) to one of the three SVGs in `public/
 * icons/`. Anything unrecognized (a future provider, a test fixture's
 * placeholder string) renders nothing — no broken image, no raw text either.
 */
const AGENT_ICON_SRC_BY_PROVIDER: Record<string, string> = {
  "claude-code": "/icons/claude.svg",
  codex: "/icons/codex.svg",
  opencode: "/icons/opencode.svg",
};

export function agentIconSrc(provider: string): string | null {
  return AGENT_ICON_SRC_BY_PROVIDER[provider] ?? null;
}

export function AgentIcon({ provider }: { provider: string }) {
  const src = agentIconSrc(provider);
  if (!src) return null;
  return <img src={src} alt="" className="size-4 shrink-0" />;
}
