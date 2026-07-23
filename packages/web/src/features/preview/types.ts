import type {
  PreviewCloseResult,
  PreviewOpenResult,
  PreviewPortInfo,
  PreviewPortsResult,
  TunnelInfo,
} from "@falcon/wire";

/**
 * View-model types for the "Preview" tab (docs/features/dev-server-preview.md
 * — "Live dev-server preview via secure tunnel", docs/competitive-notes-
 * omnara.md #6): auto-detects the machine's open local ports and, given a
 * port, opens a Cloudflare quick tunnel so the running dev server is
 * viewable remotely. Structural clone of `features/git-diff/types.ts` /
 * `features/github-checks/types.ts` — the RPC results are already exactly
 * what this panel wants to render, so they're re-exported rather than
 * redeclared.
 *
 * **Non-E2E caveat** (mirrors `@falcon/wire`'s `preview.ts` doc comment):
 * `openTunnel`'s resulting `url` is a PUBLIC, UNAUTHENTICATED link — anyone
 * who has it can reach the local dev server, and that traffic is plain
 * HTTP(S), NOT sealed under Falcon's E2E encryption the way this RPC call
 * itself is. `OpenTunnelConfirmDialog` is the mandatory consent gate this
 * caveat requires before any `openTunnel` call fires.
 */
export type PreviewPort = PreviewPortInfo;
export type PreviewTunnel = TunnelInfo;
export type PreviewPortsSnapshot = PreviewPortsResult;

/**
 * The RPC surface the Preview tab needs, seamed off from *how* those calls
 * reach the daemon — mirrors `features/git-diff`'s `GitDiffActions`. Mock by
 * default (`mock-source.ts`), swapped for
 * `machineRpcToPreviewActions(createMachineRpcClient({...}))`
 * (`live-actions.ts`) once a screen has a live `apiSocket` + a crypto client
 * holding the target machine's unwrapped DEK.
 */
export interface PreviewActions {
  /** Lists the machine's listening TCP ports plus whether `cloudflared` is installed. Throws on failure. */
  fetchPorts(): Promise<PreviewPortsSnapshot>;
  /** Lists every currently-tracked tunnel on this machine. Throws on failure. */
  fetchTunnels(): Promise<PreviewTunnel[]>;
  /** Opens (or reuses, if one already exists for this port) a Cloudflare quick tunnel for `port`. Throws on failure (`cloudflared-not-installed`, `max-tunnels-reached`, a timeout/exit message, ...). */
  openTunnel(port: number): Promise<PreviewOpenResult>;
  /** Closes a tracked tunnel by id. Idempotent — closing an already-closed tunnel is a no-op `{ok:true}`, never an error. */
  closeTunnel(tunnelId: string): Promise<PreviewCloseResult>;
}

/** One Preview-tab actions client per chosen machine — mirrors `UseGitDiffActions = (machineId) => GitDiffActions`. */
export type UsePreviewActions = (machineId: string) => PreviewActions;
