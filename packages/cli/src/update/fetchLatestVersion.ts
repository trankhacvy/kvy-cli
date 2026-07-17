/**
 * Reads the current published version off the `cli-latest` rolling GitHub
 * release tag (`.github/workflows/release.yml`'s `publish-cli-latest` job
 * re-publishes this tag's assets — including a plain-text `VERSION` file —
 * on every real `vX.Y.Z` release, so `cli-latest` always points at
 * whatever was most recently shipped without callers needing to know the
 * exact version tag up front).
 *
 * Bounded by an `AbortController` timeout — a hung or unreachable GitHub
 * must never hang the caller; `null` (never a thrown error) signals "could
 * not determine the latest version", which every caller treats as "skip
 * this update check", not as a fatal error (plan.md §16 "4.3": self-update
 * must fail safe).
 */
import { releaseAssetUrl, UPDATE_CHECK_TIMEOUT_MS } from "./config.js";

export type FetchImpl = typeof fetch;

export interface FetchLatestVersionOptions {
  repo: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export async function fetchLatestVersion(
  options: FetchLatestVersionOptions,
): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(releaseAssetUrl(options.repo, "VERSION"), {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) return null;

    const text = (await response.text()).trim();
    return text.length > 0 ? text : null;
  } catch {
    // Network error, timeout/abort, or a malformed response — every
    // failure mode collapses to "couldn't check right now", never a throw.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
