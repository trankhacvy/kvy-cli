/**
 * The 20-step conformance script itself (design §13 item 3): every step
 * below drives the real local
 * stack (`testStack.ts`) exactly the way a real client/session process
 * would — machine/session RPC calls over a real encrypted socket, real
 * transcript reads off the real server — and asserts on the observed
 * result. A failing assertion throws; `exerciseFlow.ts` catches it per-step
 * and reports PASS/FAIL for all 20 without stopping early where it's safe
 * to continue (see that file for the exact policy).
 */
import { createEnvelope, type SessionEnvelope } from "@kvy/wire";
import type { CanUseToolResult } from "./fakeSessionProcess.js";
import type { TestStack } from "./testStack.js";
import { fetchEnvelopes, waitForEnvelope, waitForPendingPermRequest } from "./transcript.js";

export class HarnessState {
  sessionId = "";
  adoptedSessionId = "";

  constructor(readonly stack: TestStack) {}

  process() {
    const tracked = this.stack.sessions.get(this.sessionId);
    if (!tracked)
      throw new Error(`HarnessState.process(): no FakeSessionProcess for "${this.sessionId}"`);
    return tracked.process;
  }
}

export interface Step {
  name: string;
  run: (state: HarnessState) => Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

/** Asserts a harness `requestTool` result resolved to the expected allow/deny (derived from the ACP permission response, see `fakeSessionProcess.ts`). */
function expectBehavior(
  result: CanUseToolResult,
  expected: "allow" | "deny",
  message: string,
): void {
  assert(result.behavior === expected, message);
}

/** Awaits `promise`, asserting that it rejects (used for the interrupt step's aborted permission call). */
async function assertRejects(promise: Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  try {
    await promise;
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

async function waitForSessionTracked(
  stack: TestStack,
  sessionId: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!stack.sessions.has(sessionId)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForSessionTracked: timed out waiting for session "${sessionId}" to come online`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function permRequestEnvelopes(envelopes: SessionEnvelope[]) {
  return envelopes.filter((e) => e.ev.t === "perm-request") as {
    ev: Extract<SessionEnvelope["ev"], { t: "perm-request" }>;
  }[];
}

function permResolveEnvelopes(envelopes: SessionEnvelope[]) {
  return envelopes.filter((e) => e.ev.t === "perm-resolve") as {
    ev: Extract<SessionEnvelope["ev"], { t: "perm-resolve" }>;
  }[];
}

export const STEPS: Step[] = [
  {
    name: "1. spawn a remote session via the machine `spawn` RPC",
    run: async (state) => {
      const result = await state.stack.callMachineRpc<{ sessionId?: string }>("spawn", {
        idempotencyKey: "e2e-spawn-1",
        workspaceId: "ws_1",
        directory: state.stack.workspaceDir,
        provider: "claude-code",
        permissionMode: "default",
      });
      assert(result.sessionId, "spawn should return a sessionId");
      state.sessionId = result.sessionId;
      await waitForSessionTracked(state.stack, state.sessionId);
    },
  },
  {
    name: "2. verify the spawned session process answers session RPCs",
    run: async (state) => {
      const result = await state.stack.callSessionRpc<{ ok: boolean }>(
        state.sessionId,
        "interrupt",
        {},
      );
      assert(
        result.ok === true,
        "a no-op interrupt (nothing pending) should still return {ok:true}",
      );
    },
  },
  {
    name: "3. controller sends the initial user message",
    run: async (state) => {
      const envelope = createEnvelope("user", { t: "text", md: "start the conformance run" });
      const result = await state.stack.callSessionRpc<{ queued: boolean }>(
        state.sessionId,
        "message",
        {
          envelope,
        },
      );
      assert(result.queued === true, "message RPC should report queued:true");
      state.process().emitTurnStart();
    },
  },
  {
    name: "4. verify the initial message landed in the transcript",
    run: async (state) => {
      await waitForEnvelope(
        state.stack,
        state.sessionId,
        (e) => e.role === "user" && e.ev.t === "text" && e.ev.md === "start the conformance run",
      );
    },
  },
  {
    name: "5. permission ALLOW (once) — Write tool",
    run: async (state) => {
      const proc = state.process();
      const pending = proc.requestTool("Write", { file_path: "/tmp/e2e.txt", content: "hello" });
      const req = await waitForPendingPermRequest(state.stack, state.sessionId, "Write");
      const answer = await state.stack.callSessionRpc<{ ok: boolean }>(
        state.sessionId,
        "perm.answer",
        {
          reqId: req.reqId,
          decision: { kind: "allow", scope: "once" },
        },
      );
      assert(answer.ok === true, "perm.answer (allow once) should succeed");
      const resolved = await pending;
      expectBehavior(resolved, "allow", "Write should have been allowed");
      await waitForEnvelope(
        state.stack,
        state.sessionId,
        (e) => e.ev.t === "perm-resolve" && e.ev.reqId === req.reqId,
      );
    },
  },
  {
    name: "6. permission DENY — Edit tool",
    run: async (state) => {
      const proc = state.process();
      const pending = proc.requestTool("Edit", {
        file_path: "/tmp/e2e.txt",
        old: "hello",
        new: "goodbye",
      });
      const req = await waitForPendingPermRequest(state.stack, state.sessionId, "Edit");
      const answer = await state.stack.callSessionRpc<{ ok: boolean }>(
        state.sessionId,
        "perm.answer",
        {
          reqId: req.reqId,
          decision: { kind: "deny", message: "not right now" },
        },
      );
      assert(answer.ok === true, "perm.answer (deny) should succeed");
      const resolved = await pending;
      expectBehavior(resolved, "deny", "Edit should have been denied");
    },
  },
  {
    name: "7. permission ALLOW-SESSION — Bash tool",
    run: async (state) => {
      const proc = state.process();
      const pending = proc.requestTool("Bash", { command: "echo hello-session" });
      const req = await waitForPendingPermRequest(state.stack, state.sessionId, "Bash");
      const answer = await state.stack.callSessionRpc<{ ok: boolean }>(
        state.sessionId,
        "perm.answer",
        {
          reqId: req.reqId,
          decision: { kind: "allow", scope: "session" },
        },
      );
      assert(answer.ok === true, "perm.answer (allow session) should succeed");
      const resolved = await pending;
      expectBehavior(resolved, "allow", "Bash echo hello-session should have been allowed");
      // Wait for this request's own perm-resolve to land on the server
      // (symmetric with step 5) so step 8's `findPendingPermRequest` — which
      // excludes resolved reqIds — can't race onto this now-answered one.
      await waitForEnvelope(
        state.stack,
        state.sessionId,
        (e) => e.ev.t === "perm-resolve" && e.ev.reqId === req.reqId,
      );
    },
  },
  {
    // v2 (ACP): allow-lists moved into the agent process — the CLI-side
    // handler no longer persists an "allow for session" decision, so
    // re-running the same tool DOES re-prompt. (A real Claude adapter
    // remembers the `allow_always` selection itself and simply wouldn't send
    // a second `session/request_permission`; that agent-side behavior is
    // covered by the provider-contract tests, not this harness.) This step
    // pins the CLI contract: every tool the agent escalates gets its own
    // fresh first-wins `perm-request`.
    name: "8. re-running the same tool re-prompts (allow-lists are agent-side under ACP)",
    run: async (state) => {
      const before = permRequestEnvelopes(
        await fetchEnvelopes(state.stack, state.sessionId),
      ).length;
      const proc = state.process();
      const pending = proc.requestTool("Bash", { command: "echo hello-session" });
      const req = await waitForPendingPermRequest(state.stack, state.sessionId, "Bash");
      const answer = await state.stack.callSessionRpc<{ ok: boolean }>(
        state.sessionId,
        "perm.answer",
        { reqId: req.reqId, decision: { kind: "allow", scope: "once" } },
      );
      assert(answer.ok === true, "perm.answer (allow once) should succeed");
      expectBehavior(await pending, "allow", "the re-run should be allowed once answered");
      const after = permRequestEnvelopes(await fetchEnvelopes(state.stack, state.sessionId)).length;
      assert(
        after > before,
        "under ACP the CLI re-prompts every escalated tool (a new perm-request envelope)",
      );
    },
  },
  {
    name: "9. question (AskUserQuestion) answered allow",
    run: async (state) => {
      const proc = state.process();
      const pending = proc.requestTool("AskUserQuestion", {
        question: "Which approach should I take?",
        options: ["A", "B"],
      });
      const req = await waitForPendingPermRequest(state.stack, state.sessionId, "AskUserQuestion");
      assert(
        req.modes.length > 0,
        "AskUserQuestion perm-request should offer at least one resolving mode",
      );
      const answer = await state.stack.callSessionRpc<{ ok: boolean }>(
        state.sessionId,
        "perm.answer",
        {
          reqId: req.reqId,
          decision: { kind: "allow", scope: "once", updatedInput: { selected: "A" } },
        },
      );
      assert(answer.ok === true, "perm.answer for the question should succeed");
      const resolved = await pending;
      expectBehavior(resolved, "allow", "the question should resolve as allowed");
    },
  },
  {
    name: "10. interrupt mid-permission-request",
    run: async (state) => {
      const proc = state.process();
      const pending = proc.requestTool("Bash", { command: "sleep 100" });
      await waitForPendingPermRequest(state.stack, state.sessionId, "Bash");
      const result = await state.stack.callSessionRpc<{ ok: boolean }>(
        state.sessionId,
        "interrupt",
        {},
      );
      assert(result.ok === true, "interrupt should return {ok:true}");
      await assertRejects(
        pending,
        "the pending Bash permission request should be rejected by interrupt",
      );
      await waitForEnvelope(
        state.stack,
        state.sessionId,
        (e) => e.ev.t === "turn-end" && e.ev.status === "cancelled",
      );
    },
  },
  {
    name: "11. mode switch #1: local -> remote via takeControl",
    run: async (state) => {
      const result = await state.stack.callSessionRpc<{ ok: boolean }>(
        state.sessionId,
        "takeControl",
        {},
      );
      assert(result.ok === true, "takeControl should return {ok:true}");
      await waitForEnvelope(
        state.stack,
        state.sessionId,
        (e) => e.ev.t === "mode-switch" && e.ev.control === "remote" && e.ev.by === "client",
      );
      assert(
        state.process().mode === "remote",
        "FakeSessionProcess should report control mode remote",
      );
    },
  },
  {
    name: "12. verify remote-mode message flow",
    run: async (state) => {
      const envelope = createEnvelope("user", { t: "text", md: "continuing in remote mode" });
      const result = await state.stack.callSessionRpc<{ queued: boolean }>(
        state.sessionId,
        "message",
        {
          envelope,
        },
      );
      assert(result.queued === true, "message RPC in remote mode should report queued:true");
      await waitForEnvelope(state.stack, state.sessionId, (e) => e.id === envelope.id);
    },
  },
  {
    name: "13. mode switch #2: remote -> local via terminal takeback",
    run: async (state) => {
      state.process().simulateTerminalTakeback();
      await waitForEnvelope(
        state.stack,
        state.sessionId,
        (e) => e.ev.t === "mode-switch" && e.ev.control === "local" && e.ev.by === "terminal",
      );
      assert(
        state.process().mode === "local",
        "FakeSessionProcess should report control mode local",
      );
    },
  },
  {
    name: "14. verify mode-switch envelope ordering (local -> remote -> local)",
    run: async (state) => {
      const envelopes = await fetchEnvelopes(state.stack, state.sessionId);
      const switches = envelopes
        .filter((e) => e.ev.t === "mode-switch")
        .map((e) => (e.ev as Extract<SessionEnvelope["ev"], { t: "mode-switch" }>).control);
      assert(
        switches.length === 2 && switches[0] === "remote" && switches[1] === "local",
        `expected exactly one remote-then-local mode-switch pair, got [${switches.join(", ")}]`,
      );
    },
  },
  {
    name: "15. reconnect — session process socket disconnect/reconnect",
    run: async (state) => {
      const proc = state.process();
      await proc.disconnectSocket();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await proc.reconnectSocket();
      // `registerSessionRpcHandlers`'s own `connect` listener re-emits
      // `rpc-register` synchronously on reconnect, but that's a fire-and-forget
      // client->server frame racing this step's own `connect`-event promise
      // resolution — give it a moment to land server-side (room re-joined)
      // before the next step immediately calls an RPC against it.
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
  },
  {
    name: "16. verify session RPC still reachable after the session process reconnects",
    run: async (state) => {
      const result = await state.stack.callSessionRpc<{ ok: boolean }>(
        state.sessionId,
        "interrupt",
        {},
      );
      assert(
        result.ok === true,
        "interrupt should still work after the session process reconnects",
      );
    },
  },
  {
    name: "17. reconnect — controller socket disconnect/reconnect",
    run: async (state) => {
      const controller = state.stack.controller;
      controller.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await new Promise<void>((resolve, reject) => {
        controller.once("connect", () => resolve());
        controller.once("connect_error", (error: Error) => reject(error));
        controller.connect();
      });
    },
  },
  {
    name: "18. verify a fresh permission round trip works after the controller reconnects",
    run: async (state) => {
      const proc = state.process();
      const pending = proc.requestTool("Grep", { pattern: "TODO" });
      const req = await waitForPendingPermRequest(state.stack, state.sessionId, "Grep");
      const answer = await state.stack.callSessionRpc<{ ok: boolean }>(
        state.sessionId,
        "perm.answer",
        {
          reqId: req.reqId,
          decision: { kind: "allow", scope: "once" },
        },
      );
      assert(answer.ok === true, "perm.answer after reconnect should succeed");
      const resolved = await pending;
      expectBehavior(resolved, "allow", "Grep should have been allowed");
    },
  },
  {
    name: "19. adoption takeover via adopt.take",
    run: async (state) => {
      const result = await state.stack.callMachineRpc<{ sessionId: string; warning?: string }>(
        "adopt.take",
        {
          idempotencyKey: "e2e-adopt-1",
          providerSessionId: "prov_1",
          mode: "takeover",
        },
      );
      assert(
        typeof result.sessionId === "string" && result.sessionId.length > 0,
        "adopt.take should return a sessionId",
      );
      assert(
        result.sessionId !== state.sessionId,
        "adoption should mint a distinct continuation session",
      );
      state.adoptedSessionId = result.sessionId;
      await waitForSessionTracked(state.stack, state.adoptedSessionId);
    },
  },
  {
    name: "20. final transcript integrity check",
    run: async (state) => {
      const envelopes = await fetchEnvelopes(state.stack, state.sessionId);

      assert(
        envelopes.some((e) => e.ev.t === "turn-start"),
        "expected at least one turn-start envelope",
      );
      assert(
        envelopes.some((e) => e.ev.t === "turn-end" && e.ev.status === "cancelled"),
        "expected the interrupted turn's turn-end{cancelled}",
      );

      const requests = permRequestEnvelopes(envelopes);
      const resolves = permResolveEnvelopes(envelopes);
      const resolvedIds = new Set(resolves.map((e) => e.ev.reqId));
      const unresolved = requests.filter((e) => !resolvedIds.has(e.ev.reqId));

      assert(
        requests.length === 7,
        // v2 (ACP): step 8 now escalates its own perm-request (the CLI no
        // longer persists allow-session), so the Bash re-run adds a 7th.
        `expected 7 perm-request envelopes (Write/Edit/Bash/Bash/AskUserQuestion/Bash/Grep), got ${requests.length}`,
      );
      // v2 (ACP): an interrupted permission request now emits a *cancelled*
      // perm-resolve (the AcpPermissionHandler settles the PermCard rather
      // than leaving it dangling, unlike v1) — so EVERY request resolves.
      assert(
        resolves.length === 7,
        `expected 7 perm-resolve envelopes (interrupted requests now resolve as cancelled), got ${resolves.length}`,
      );
      assert(
        unresolved.length === 0,
        `expected no unresolved perm-requests (interrupt now settles its own), got ${unresolved.length}`,
      );
      const cancelledResolve = resolves.find(
        (e) =>
          e.ev.decision.kind === "deny" && e.ev.decision.message === "Permission request cancelled",
      );
      assert(
        cancelledResolve !== undefined,
        "the interrupted Bash call should have a cancelled (deny) perm-resolve",
      );

      assert(
        state.adoptedSessionId.length > 0,
        "adoption takeover should have recorded a continuation sessionId",
      );
      assert(
        state.stack.sessions.has(state.adoptedSessionId),
        "the adopted continuation session's process should be tracked",
      );
    },
  },
];
