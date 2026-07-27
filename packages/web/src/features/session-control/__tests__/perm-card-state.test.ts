import type { PermDecision } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import { applyAnswerResult, fromError } from "../perm-card-state.js";

const allowOnce: PermDecision = { kind: "allow", scope: "once" };
const denyDecision: PermDecision = { kind: "deny" };

describe("applyAnswerResult", () => {
  it("transitions to 'answered' with our own decision when we won", () => {
    expect(applyAnswerResult(allowOnce, { ok: true })).toEqual({
      kind: "answered",
      decision: allowOnce,
    });
  });

  it("transitions to 'lost-race' with the winning decision when someone else answered first", () => {
    expect(
      applyAnswerResult(allowOnce, {
        ok: false,
        reason: "already-answered",
        decision: denyDecision,
      }),
    ).toEqual({ kind: "lost-race", decision: denyDecision });
  });

  it("transitions to 'error' when ok:false carries no already-answered decision", () => {
    const result = applyAnswerResult(allowOnce, { ok: false });
    expect(result.kind).toBe("error");
  });

  it("transitions to 'error' when reason is already-answered but decision is missing (malformed)", () => {
    const result = applyAnswerResult(allowOnce, { ok: false, reason: "already-answered" });
    expect(result.kind).toBe("error");
  });

  it("transitions to 'not-answerable' when reason is local-turn — not a generic error", () => {
    expect(applyAnswerResult(allowOnce, { ok: false, reason: "local-turn" })).toEqual({
      kind: "not-answerable",
    });
  });
});

describe("fromError", () => {
  it("carries an Error's message", () => {
    expect(fromError(new Error("target-offline"))).toEqual({
      kind: "error",
      message: "target-offline",
    });
  });

  it("falls back to a generic message for a non-Error throw", () => {
    expect(fromError("boom")).toEqual({
      kind: "error",
      message: "Could not reach the session.",
    });
  });
});
