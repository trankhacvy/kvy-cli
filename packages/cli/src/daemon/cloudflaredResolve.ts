/**
 * `cloudflared` binary detection (docs/features/dev-server-preview.md):
 * `cloudflared` is a Go binary, not an npm package, so the pinned-manifest
 * npm-install adapter manager (`packages/cli/src/adapters/`) doesn't apply
 * here — Falcon never installs it, only detects it on `PATH`, mirroring how
 * `ProviderAdapter.detect()` detects the `claude`/`codex` CLIs.
 *
 * This is the single detection point reused by the `preview.ports` RPC
 * handler (surfaces `cloudflared.installed` alongside the port list),
 * `previewTunnel.ts`'s `handlePreviewOpen` (refuses to spawn a tunnel when
 * missing), and `doctor.ts`'s new preview section.
 *
 * Never throws — same "best-effort, swallow-and-degrade" contract as
 * `providerAccountInfo.ts`: a missing binary, a `--version` that exits
 * non-zero, or output in a format this can't parse all degrade to an honest
 * `{installed: false}` (or `installed: true` with `version` simply omitted),
 * never a thrown error.
 */
import { execFile } from "node:child_process";

export interface CloudflaredDetection {
  installed: boolean;
  version?: string;
  path?: string;
}

export interface CloudflaredResolveDeps {
  /** Injectable for tests; defaults to a real `cloudflared --version` invocation. Resolves `null` on any failure (ENOENT, non-zero exit, ...). */
  runVersion?: () => Promise<string | null>;
  /** Injectable for tests; defaults to a real `which cloudflared` (POSIX) lookup. Resolves `null` on any failure — best-effort, never load-bearing. */
  runWhich?: () => Promise<string | null>;
}

function defaultRunVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("cloudflared", ["--version"], { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout.toString());
    });
  });
}

function defaultRunWhich(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("which", ["cloudflared"], { maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const trimmed = stdout.toString().trim();
      resolve(trimmed === "" ? null : trimmed);
    });
  });
}

/**
 * Leniently extracts a version token from `cloudflared --version`'s output
 * (e.g. `"cloudflared version 2024.6.1 (built 2024-06-10-1200 UTC)"`) —
 * whatever looks like a dotted/dashed version-ish token right after the word
 * "version", falling back to `undefined` (never throwing) if the format
 * doesn't match at all, since this isn't a stable, documented API.
 */
function parseVersion(output: string): string | undefined {
  const match = /version\s+([^\s(]+)/i.exec(output);
  return match?.[1];
}

/** Detects whether `cloudflared` is installed and, if so, its version/path. Never throws. */
export async function detectCloudflared(
  deps: CloudflaredResolveDeps = {},
): Promise<CloudflaredDetection> {
  const runVersion = deps.runVersion ?? defaultRunVersion;
  const runWhich = deps.runWhich ?? defaultRunWhich;

  const versionOutput = await runVersion();
  if (versionOutput === null) {
    return { installed: false };
  }

  const version = parseVersion(versionOutput);
  const rawPath = await runWhich().catch(() => null);
  const path = rawPath?.trim() || null;

  return {
    installed: true,
    ...(version !== undefined ? { version } : {}),
    ...(path !== null ? { path } : {}),
  };
}
