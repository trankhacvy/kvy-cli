import { GithubChecksResultSchema } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import { createMockGithubChecksActions, MOCK_GITHUB_CHECKS_FIXTURES } from "../mock-source";

describe("MOCK_GITHUB_CHECKS_FIXTURES", () => {
  it("every fixture validates against GithubChecksResultSchema", () => {
    for (const [state, fixture] of Object.entries(MOCK_GITHUB_CHECKS_FIXTURES)) {
      expect(fixture.state).toBe(state);
      expect(GithubChecksResultSchema.safeParse(fixture).success).toBe(true);
    }
  });

  it("the 'ok' fixture has a pr and a non-empty mixed-status checks list", () => {
    const ok = MOCK_GITHUB_CHECKS_FIXTURES.ok;
    expect(ok.pr).toBeDefined();
    expect(ok.checks?.length).toBeGreaterThan(1);
    const statuses = new Set(ok.checks?.map((c) => c.status));
    expect(statuses.size).toBeGreaterThan(1);
  });
});

describe("createMockGithubChecksActions", () => {
  it("defaults to the 'ok' fixture", async () => {
    const actions = createMockGithubChecksActions("mach-1");
    const result = await actions.fetchChecks("/repo");
    expect(result.state).toBe("ok");
  });

  it("returns the requested fixture state when given", async () => {
    const actions = createMockGithubChecksActions("mach-1", "no-token");
    const result = await actions.fetchChecks("/repo");
    expect(result).toEqual(MOCK_GITHUB_CHECKS_FIXTURES["no-token"]);
  });
});
