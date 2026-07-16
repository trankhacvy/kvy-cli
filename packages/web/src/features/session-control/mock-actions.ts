import type { PermDecision } from "@falcon/wire";
import type { SessionControlActions, UseSessionControl } from "./types";

const LATENCY_MS = 350;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The screen's default data source for `SessionControlActions` — mirrors
 * `features/session-list/mock-source.ts`'s role: `apiSocket`/a live
 * per-session crypto client aren't wired into this screen yet (this
 * screen still runs off `demo-items.ts`, a separate in-flight task), so
 * this simulates the five session RPCs with realistic latency, kept to the
 * same call signature (`UseSessionControl`) so swapping in
 * `sessionRpcToActions(createSessionRpcClient({...}))` later is a one-line
 * change at the call site.
 *
 * `demo-items.ts`'s standalone pending permission (`reqId: "req-1"`) always
 * resolves as "answered on another device" here — a deliberate demo
 * showcase of design §7.6's first-wins-across-devices case, which is
 * otherwise a rare race to hit by hand. Every other `reqId` "wins" normally.
 */
export function createMockSessionControl(_sessionId: string): SessionControlActions {
  return {
    async sendMessage() {
      await delay(LATENCY_MS);
      return { queued: false };
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
