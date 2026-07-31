import { z } from "zod";

export const PROVIDER_IDS = ["claude-code", "codex"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const ProviderIdSchema = z.enum(PROVIDER_IDS);

export interface ProviderCapabilities {
  hasLocalMode: boolean;
  supportsLiveModeSwitch: boolean;
  supportsLiveModelSwitch: boolean;
  supportsTakeControl: boolean;
  supportsResume: boolean;
}

export const PROVIDER_CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  "claude-code": {
    hasLocalMode: true,
    supportsLiveModeSwitch: true,
    supportsLiveModelSwitch: true,
    supportsTakeControl: true,
    supportsResume: true,
  },
  codex: {
    hasLocalMode: false,
    supportsLiveModeSwitch: true,
    supportsLiveModelSwitch: false,
    supportsTakeControl: false,
    supportsResume: true,
  },
};

const UNKNOWN_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  hasLocalMode: false,
  supportsLiveModeSwitch: false,
  supportsLiveModelSwitch: false,
  supportsTakeControl: false,
  supportsResume: false,
};

export function getProviderCapabilities(provider: string): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[provider as ProviderId] ?? UNKNOWN_PROVIDER_CAPABILITIES;
}
