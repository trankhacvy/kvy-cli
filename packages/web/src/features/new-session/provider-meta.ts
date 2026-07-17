import type { NewSessionProvider } from "./types";

/**
 * Display metadata for each provider the "Options" step's picker offers.
 * Codex is flagged `beta` per falcon-system-design.md §15 resolution #3
 * ("Codex depth at M3: beta banner") — the design deliberately doesn't
 * claim parity with Claude Code, so the picker surfaces that honestly
 * (mirrors `falcon codex`'s own CLI-side "(beta, no local TUI)" note,
 * `packages/cli/src/index.ts`) instead of presenting both providers as
 * equivalent choices.
 */
export interface ProviderMeta {
  label: string;
  beta: boolean;
  /** Rendered as a banner under the picker when this provider is selected. Unset for non-beta providers. */
  betaNote?: string;
}

export const PROVIDER_META: Record<NewSessionProvider, ProviderMeta> = {
  "claude-code": { label: "Claude Code", beta: false },
  codex: {
    label: "Codex",
    beta: true,
    betaNote:
      "Codex support is in beta: no local TUI attach, and feature parity with Claude Code may lag.",
  },
};

/** Ordered `[value, meta]` pairs for rendering `<option>`s — `Object.entries` doesn't guarantee the declaration order is preserved across engines for non-numeric keys, so this pins it explicitly. */
export const PROVIDER_OPTIONS: Array<[NewSessionProvider, ProviderMeta]> = [
  ["claude-code", PROVIDER_META["claude-code"]],
  ["codex", PROVIDER_META.codex],
];
