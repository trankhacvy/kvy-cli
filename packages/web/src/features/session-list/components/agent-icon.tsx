import { getProviderMeta } from "@/lib/providers";

export function agentIconSrc(provider: string): string | null {
  return getProviderMeta(provider).iconSrc || null;
}

export function AgentIcon({ provider }: { provider: string }) {
  const src = agentIconSrc(provider);
  if (!src) return null;
  return <img src={src} alt="" className="size-4 shrink-0" />;
}
