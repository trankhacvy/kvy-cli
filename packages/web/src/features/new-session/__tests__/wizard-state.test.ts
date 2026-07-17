import { describe, expect, it } from "vitest";
import type { ImportCandidate } from "../types";
import {
  buildSpawnRequest,
  canAdvance,
  INITIAL_FORM,
  nextStep,
  previousStep,
} from "../wizard-state";

const CANDIDATE: ImportCandidate = {
  providerSessionId: "prov-1",
  title: "Fix the flaky test",
  lastActivityAt: 1_000,
  running: true,
};

describe("canAdvance", () => {
  it("blocks the machine step until a machine is picked", () => {
    expect(canAdvance("machine", INITIAL_FORM)).toBe(false);
    expect(canAdvance("machine", { ...INITIAL_FORM, machineId: "m1" })).toBe(true);
  });

  it("blocks the directory step until a directory is picked", () => {
    expect(canAdvance("directory", { ...INITIAL_FORM, machineId: "m1" })).toBe(false);
    expect(canAdvance("directory", { ...INITIAL_FORM, machineId: "m1", directory: "/tmp" })).toBe(
      true,
    );
  });

  it("import step is always advanceable — selecting a candidate is optional", () => {
    const base = { ...INITIAL_FORM, machineId: "m1", directory: "/tmp" };
    expect(canAdvance("import", base)).toBe(true);
    expect(canAdvance("import", { ...base, importCandidate: CANDIDATE })).toBe(true);
  });

  it("options step: fine when branch is disabled, requires a non-blank name when enabled", () => {
    const base = { ...INITIAL_FORM, machineId: "m1", directory: "/tmp" };
    expect(canAdvance("options", base)).toBe(true);
    expect(canAdvance("options", { ...base, branchEnabled: true, branchName: "" })).toBe(false);
    expect(canAdvance("options", { ...base, branchEnabled: true, branchName: "  " })).toBe(false);
    expect(canAdvance("options", { ...base, branchEnabled: true, branchName: "task-1" })).toBe(
      true,
    );
  });

  it("review step is always advanceable", () => {
    expect(canAdvance("review", INITIAL_FORM)).toBe(true);
  });
});

describe("nextStep / previousStep", () => {
  it("walks forward through machine -> directory -> import -> options -> review and clamps at the end", () => {
    expect(nextStep("machine")).toBe("directory");
    expect(nextStep("directory")).toBe("import");
    expect(nextStep("import")).toBe("options");
    expect(nextStep("options")).toBe("review");
    expect(nextStep("review")).toBe("review");
  });

  it("walks backward and clamps at the start", () => {
    expect(previousStep("review")).toBe("options");
    expect(previousStep("options")).toBe("import");
    expect(previousStep("import")).toBe("directory");
    expect(previousStep("directory")).toBe("machine");
    expect(previousStep("machine")).toBe("machine");
  });
});

describe("buildSpawnRequest", () => {
  it("throws when no directory has been chosen yet", () => {
    expect(() => buildSpawnRequest(INITIAL_FORM)).toThrow();
  });

  it("omits model when blank and branch when disabled", () => {
    const request = buildSpawnRequest({
      ...INITIAL_FORM,
      machineId: "m1",
      directory: "/repo",
      model: "  ",
    });
    expect(request).toEqual({
      directory: "/repo",
      provider: "claude-code",
      permissionMode: "default",
      model: undefined,
      branch: undefined,
      continueFrom: undefined,
    });
  });

  it("trims model and includes the branch/worktree option when enabled", () => {
    const request = buildSpawnRequest({
      ...INITIAL_FORM,
      machineId: "m1",
      directory: "/repo",
      model: " opus ",
      branchEnabled: true,
      branchName: " task-1 ",
      createWorktree: true,
    });
    expect(request).toEqual({
      directory: "/repo",
      provider: "claude-code",
      permissionMode: "default",
      model: "opus",
      branch: { name: "task-1", createWorktree: true },
      continueFrom: undefined,
    });
  });

  it("carries the picked provider (e.g. codex) through to the spawn request", () => {
    const request = buildSpawnRequest({
      ...INITIAL_FORM,
      machineId: "m1",
      directory: "/repo",
      provider: "codex",
    });
    expect(request.provider).toBe("codex");
  });

  it("includes continueFrom when an import candidate was picked", () => {
    const request = buildSpawnRequest({
      ...INITIAL_FORM,
      machineId: "m1",
      directory: "/repo",
      importCandidate: CANDIDATE,
    });
    expect(request.continueFrom).toEqual({ providerSessionId: "prov-1" });
  });

  it("omits continueFrom when no import candidate was picked", () => {
    const request = buildSpawnRequest({
      ...INITIAL_FORM,
      machineId: "m1",
      directory: "/repo",
    });
    expect(request.continueFrom).toBeUndefined();
  });
});
