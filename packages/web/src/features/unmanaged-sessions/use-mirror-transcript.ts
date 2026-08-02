import { useQuery } from "@tanstack/react-query";
import { fetchFullTranscript, type MirrorLine, parseMirrorLines } from "./mirror";
import type { UnmanagedActions } from "./types";

/** How often the mirror view re-reads the transcript from the daemon.
 * This is on-demand polling, not a stream, so the interval stays modest. */
const POLL_INTERVAL_MS = 4000;

export interface MirrorTranscriptState {
  lines: MirrorLine[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Polls `actions.mirror` on an interval, reassembling the full transcript each
 * time and parsing it into a readable line feed. Never shows a hard error for a
 * transient poll failure - previous lines stay on screen; `error` is only set
 * when `lines` is still empty (i.e. the first load failed).
 */
export function useMirrorTranscript(
  actions: Pick<UnmanagedActions, "mirror">,
  providerSessionId: string,
): MirrorTranscriptState {
  const query = useQuery({
    queryKey: ["unmanaged-mirror", providerSessionId],
    queryFn: () => fetchFullTranscript(actions, providerSessionId),
    enabled: providerSessionId !== "",
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  const lines = query.data !== undefined ? parseMirrorLines(query.data) : [];
  const error =
    query.status === "error" && lines.length === 0
      ? query.error instanceof Error
        ? query.error.message
        : String(query.error)
      : null;

  return { lines, isLoading: query.isLoading, error };
}
