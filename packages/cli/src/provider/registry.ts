import type { ProviderId } from "@falcon/wire";
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
  falconSubcommand: string;
  accountConfigPath: (homeDir: string) => string;
  detect: () => Promise<ProviderDetectionResult>;
}

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderRegistryEntry> = {
  "claude-code": {
    id: "claude-code",
    falconSubcommand: "claude",
    accountConfigPath: () => "~/.claude.json",
    detect: claudeCodeProvider.detect,
  },
  codex: {
    id: "codex",
    falconSubcommand: "codex",
    accountConfigPath: () => "~/.codex/auth.json",
    detect: codexProvider.detect,
  },
};

export function providerIdForSubcommand(subcommand: string): ProviderId | null {
  const entry = Object.values(PROVIDER_REGISTRY).find((e) => e.falconSubcommand === subcommand);
  return entry?.id ?? null;
}
