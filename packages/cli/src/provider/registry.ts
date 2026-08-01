import type { ProviderId } from "@kvy/wire";
import { codexProvider } from "../codex/index.js";
import { claudeCodeProvider } from "./claudeProviderAdapter.js";

export interface ProviderDetectionResult {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  error?: string;
}

export interface ProviderRegistryEntry {
  id: ProviderId;
  kvySubcommand: string;
  accountConfigPath: (homeDir: string) => string;
  detect: () => Promise<ProviderDetectionResult>;
}

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderRegistryEntry> = {
  "claude-code": {
    id: "claude-code",
    kvySubcommand: "claude",
    accountConfigPath: () => "~/.claude.json",
    detect: claudeCodeProvider.detect,
  },
  codex: {
    id: "codex",
    kvySubcommand: "codex",
    accountConfigPath: () => "~/.codex/auth.json",
    detect: codexProvider.detect,
  },
};

export function providerIdForSubcommand(subcommand: string): ProviderId | null {
  const entry = Object.values(PROVIDER_REGISTRY).find((e) => e.kvySubcommand === subcommand);
  return entry?.id ?? null;
}
