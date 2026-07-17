import type { PermDecision } from "@falcon/wire";
import type { SessionControlActions, UseSessionControl } from "./types";

const LATENCY_MS = 350;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A `SessionControlActions` source that simulates the five session RPCs
 * with realistic latency instead of calling the real ones — mirrors
 * `features/session-list/mock-source.ts`'s role. No longer
 * `SessionTimelineScreen`'s default (`useLiveSessionControl` is, since the
 * real sync engine + per-session crypto client are wired in), but kept
 * around, to the same call signature (`UseSessionControl`), for tests/
 * standalone review that want to exercise the control surface without a
 * live server.
 *
 * The standalone pending permission `reqId: "req-1"` always resolves as
 * "answered on another device" here — a deliberate demo showcase of design
 * §7.6's first-wins-across-devices case, which is otherwise a rare race to
 * hit by hand. Every other `reqId` "wins" normally.
 */
export function createMockSessionControl(_sessionId: string): SessionControlActions {
  return {
    async sendMessage() {
      await delay(LATENCY_MS);
      return { queued: false, status: "queued" };
    },
    async answerPermission(reqId) {
      await delay(LATENCY_MS);
      if (reqId === "req-1") {
        const winningDecision: PermDecision = { kind: "allow", scope: "once" };
        return { ok: false, reason: "already-answered", decision: winningDecision };
      }
      return { ok: true };
    },
    async interrupt() {
      await delay(LATENCY_MS);
      return { ok: true };
    },
    async takeControl() {
      await delay(LATENCY_MS);
      return { ok: true };
    },
    async setMode() {
      await delay(LATENCY_MS);
      return { ok: true };
    },
  };
}

export const useMockSessionControl: UseSessionControl = (sessionId) =>
  createMockSessionControl(sessionId);
