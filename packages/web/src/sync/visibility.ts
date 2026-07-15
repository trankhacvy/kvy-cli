/**
 * Browser tab visibility -> `app-state` (design §9.1/§9.3: "`app-state`
 * reported on visibility/focus changes" — the input to the server's push
 * suppression logic, §6.4). Ported from Happy's React Native `AppState`
 * listener; the web equivalent is `document.visibilitychange`.
 *
 * Defensive against build-time evaluation: Next prerenders pages in a Node
 * environment where `document` doesn't exist (design: static export, no
 * server rendering of user content) — fall back to "active" and a no-op
 * subscription instead of throwing.
 */
import type { AppState, VisibilitySource } from "./apiSocket.js";

function readState(): AppState {
  if (typeof document === "undefined") return "active";
  return document.visibilityState === "visible" ? "active" : "background";
}

export function createBrowserVisibilitySource(): VisibilitySource {
  return {
    currentState: readState,
    subscribe(handler: (state: AppState) => void): () => void {
      if (typeof document === "undefined") {
        return () => {};
      }
      const listener = () => handler(readState());
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}
