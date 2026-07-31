import { getProviderCapabilities, type ProviderId } from "@falcon/wire";

export type { ProviderCapabilities } from "@falcon/wire";
export { getProviderCapabilities };

export interface ModelOption {
  value: string;
  label: string;
}

export const DEFAULT_MODEL_VALUE = "__default__";
const DEFAULT_MODEL_OPTION: ModelOption = { value: DEFAULT_MODEL_VALUE, label: "Provider default" };

export interface WebProviderMeta {
  id: ProviderId;
  label: string;
  iconSrc: string;
  beta: boolean;
  betaNote?: string;
  spawnModels: ModelOption[];
  runningSessionModels: ModelOption[];
}

const UNKNOWN_PROVIDER_META: WebProviderMeta = {
  id: "codex",
  label: "Agent",
  iconSrc: "",
  beta: false,
  spawnModels: [DEFAULT_MODEL_OPTION],
  runningSessionModels: [],
};

export const PROVIDER_META: Record<ProviderId, WebProviderMeta> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    iconSrc: "/icons/claude.svg",
    beta: false,
    spawnModels: [
      DEFAULT_MODEL_OPTION,
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
      { value: "haiku", label: "Haiku" },
      { value: "sonnet[1m]", label: "Sonnet (1M)" },
      { value: "opus[1m]", label: "Opus (1M)" },
    ],
    runningSessionModels: [
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
      { value: "haiku", label: "Haiku" },
      { value: "sonnet[1m]", label: "Sonnet (1M)" },
      { value: "opus[1m]", label: "Opus (1M)" },
    ],
  },
  codex: {
    id: "codex",
    label: "Codex",
    iconSrc: "/icons/codex.svg",
    beta: true,
    betaNote:
      "Codex support is in beta: no local TUI attach, and feature parity with Claude Code may lag.",
    spawnModels: [
      DEFAULT_MODEL_OPTION,
      { value: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
      { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
    ],
    runningSessionModels: [],
  },
};

export function getProviderMeta(provider: string): WebProviderMeta {
  const meta = PROVIDER_META[provider as ProviderId];
  if (meta) return meta;
  return { ...UNKNOWN_PROVIDER_META, label: provider || "Agent" };
}
