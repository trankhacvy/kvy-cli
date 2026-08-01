/**
 * Pinned-version manifest for Kvy's managed ACP adapter installs (design
 * §7.9, plan.md §16 "Phase 2.0 — foundation": "Adapter manager
 * (`cli/src/adapters/`, design §7.9): pinned-version manifest (package id +
 * exact version + integrity hash), install into `~/.kvy/adapters/` own
 * npm prefix, verify-before-spawn, `kvy adapters install|upgrade`
 * command, `kvy doctor` adapter checks. No npx at session start").
 *
 * Each entry pins an *exact* version and its npm-registry `dist.integrity`
 * (a standard Subresource Integrity string, `sha512-<base64>`) — the exact
 * value `npm view <package>@<version> dist.integrity` reports at the time
 * this manifest was written. `install.ts` verifies the resulting install
 * against these two fields (never a range, never "latest"): a Kvy
 * release bumps this manifest deliberately; the user upgrades deliberately
 * via `kvy adapters upgrade`. Never fetched or resolved dynamically at
 * session start — that's the whole point of not using `npx`.
 *
 * Package-name note: the design doc's prose shorthand ("`claude-agent-acp`
 * / `codex-acp`") refers to the *unscoped* package names. Both official ACP
 * adapters are actually published npm-scoped, under
 * `@agentclientprotocol/*` (verified directly against the npm registry
 * while writing this manifest — `claude-agent-acp`/`codex-acp` unscoped do
 * not exist; a since-deprecated predecessor of the Claude adapter,
 * `@zed-industries/claude-code-acp`, redirects to this one). `binEntry` is
 * each package's own declared `bin` entrypoint (`package.json`'s `bin`
 * field) — the NDJSON-over-stdio ACP server Phase 2.1's
 * `acpConnection.ts` spawns via `node <adapters>/node_modules/<packageName>/<binEntry>`.
 */

export type AdapterId = "claude-code" | "codex";

export interface AdapterManifestEntry {
  /** Matches `ProviderAdapter.id` (design §7.3). */
  id: AdapterId;
  /** Human label for CLI/`kvy doctor` output. */
  label: string;
  /** Exact npm package name — always scoped, see file header. */
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
