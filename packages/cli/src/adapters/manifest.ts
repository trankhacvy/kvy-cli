export type AdapterId = "claude-code" | "codex";

export interface AdapterManifestEntry {
  id: AdapterId;
  /** Human label for CLI/`kvy doctor` output. */
  label: string;
  /** Exact npm package name — always scoped under `@agentclientprotocol/*`. */
  packageName: string;
  /** Exact pinned version. Never a semver range. */
  version: string;
  /** `dist.integrity` (SRI, `sha512-...`) for `packageName@version`, straight from the npm registry. */
  integrity: string;
  /** Relative path (from the installed package's own directory) to its ACP-server stdio entrypoint. */
  binEntry: string;
}

export const ADAPTER_MANIFEST: Readonly<Record<AdapterId, AdapterManifestEntry>> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    packageName: "@agentclientprotocol/claude-agent-acp",
    version: "0.59.0",
    integrity:
      "sha512-GejLH5qxsI5IoSDfhyOVDEsRNxqi6y0Rcj5FstVeOwMACSht/bUXII0HILbzOQNoA5qlyZle3FRvf+CAjD7Rpg==",
    binEntry: "dist/index.js",
  },
  codex: {
    id: "codex",
    label: "Codex",
    packageName: "@agentclientprotocol/codex-acp",
    version: "1.1.4",
    integrity:
      "sha512-DzusIpGwlQwMWuHgJhU8FWMsyQvzjenB93IEzQATkdbNulo5Rd9GKOz8+B+/C9iWWxmyXgtgmjzaL+iRFyDryQ==",
    binEntry: "dist/index.js",
  },
};

export const ADAPTER_IDS: readonly AdapterId[] = Object.keys(ADAPTER_MANIFEST) as AdapterId[];
