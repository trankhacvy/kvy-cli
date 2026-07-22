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

  it("options step: fine in repo-root mode, requires a non-blank name in new-branch/existing-branch mode", () => {
    const base = { ...INITIAL_FORM, machineId: "m1", directory: "/tmp" };
    expect(canAdvance("options", base)).toBe(true);
    expect(
      canAdvance("options", { ...base, branchMode: "new-branch" as const, branchName: "" }),
    ).toBe(false);
    expect(
      canAdvance("options", { ...base, branchMode: "new-branch" as const, branchName: "  " }),
    ).toBe(false);
    expect(
      canAdvance("options", { ...base, branchMode: "new-branch" as const, branchName: "task-1" }),
    ).toBe(true);
    expect(
      canAdvance("options", {
        ...base,
        branchMode: "existing-branch" as const,
        branchName: "",
      }),
    ).toBe(false);
    expect(
      canAdvance("options", {
        ...base,
        branchMode: "existing-branch" as const,
        branchName: "main",
      }),
    ).toBe(true);
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

  it("omits model when blank and branch in repo-root mode", () => {
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

  it("trims model and includes the branch/worktree option in new-branch mode", () => {
    const request = buildSpawnRequest({
      ...INITIAL_FORM,
      machineId: "m1",
      directory: "/repo",
      model: " opus ",
      branchMode: "new-branch",
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

  it("respects createWorktree: false in new-branch mode", () => {
    const request = buildSpawnRequest({
      ...INITIAL_FORM,
      machineId: "m1",
      directory: "/repo",
      branchMode: "new-branch",
      branchName: "task-1",
      createWorktree: false,
    });
    expect(request.branch).toEqual({ name: "task-1", createWorktree: false });
  });

  it("includes `from` in new-branch mode when a base branch was picked (docs/competitive-notes-omnara.md #16)", () => {
    const request = buildSpawnRequest({
      ...INITIAL_FORM,
      machineId: "m1",
      directory: "/repo",
      branchMode: "new-branch",
      branchName: "task-1",
      baseBranch: " main ",
    });
    expect(request.branch).toEqual({ name: "task-1", createWorktree: true, from: "main" });
  });

  it("omits `from` in new-branch mode when no base branch was picked (falls back to branching off HEAD)", () => {
    const request = buildSpawnRequest({
      ...INITIAL_FORM,
      machineId: "m1",
      directory: "/repo",
      branchMode: "new-branch",
      branchName: "task-1",
      baseBranch: "",
    });
    expect(request.branch).toEqual({ name: "task-1", createWorktree: true });
    expect(request.branch?.from).toBeUndefined();
  });

  it("omits `from` in existing-branch mode even if a stale baseBranch value is left over from new-branch mode", () => {
    const request = buildSpawnRequest({
      ...INITIAL_FORM,
      machineId: "m1",
      directory: "/repo",
      branchMode: "existing-branch",
      branchName: "main",
      baseBranch: "develop",
    });
    expect(request.branch).toEqual({ name: "main", createWorktree: true });
    expect(request.branch?.from).toBeUndefined();
  });

  it("existing-branch mode always isolates in a fresh worktree, regardless of createWorktree", () => {
    const request = buildSpawnRequest({
      ...INITIAL_FORM,
      machineId: "m1",
      directory: "/repo",
      branchMode: "existing-branch",
      branchName: "main",
      createWorktree: false,
    });
    expect(request.branch).toEqual({ name: "main", createWorktree: true });
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
