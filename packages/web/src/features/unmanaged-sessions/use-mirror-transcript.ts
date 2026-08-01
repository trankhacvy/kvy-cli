import { useQuery } from "@tanstack/react-query";
import { fetchFullTranscript, type MirrorLine, parseMirrorLines } from "./mirror";
import type { UnmanagedActions } from "./types";

/** How often the mirror view re-reads the transcript from the daemon (design
 * §10.4 "live read-only mirror via chunked RPC"). A live plain-`claude`
 * session is not itself pushing updates over the WS — this is on-demand
 * polling, not a stream — so this stays modest rather than aggressive. */
const POLL_INTERVAL_MS = 4000;

export interface MirrorTranscriptState {
  lines: MirrorLine[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Live read-only transcript mirror (kvy-system-design.md §8/§10.4,
 * plan.md §16 "3.3 Session adoption (UC9)"): polls `actions.mirror` on an
 * interval, reassembling the full transcript from cursor `0` each time
 * (`fetchFullTranscript`) and parsing it into a readable line feed. Never
 * shows a hard error for a transient poll failure — the previous
 * successfully-parsed lines stay on screen (design §9.1 "never show a
 * loading error — retry silently"); `error` is surfaced only alongside
 * still-empty `lines` (first load failed).
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
