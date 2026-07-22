import { describe, expect, it } from "vitest";
import { createMockProviderAccountActions } from "../mock-source";

describe("createMockProviderAccountActions", () => {
  it("fetchAccount('claude-code') returns an authenticated account with email/organization/usage", async () => {
    const actions = createMockProviderAccountActions("mach-1");
    const account = await actions.fetchAccount("claude-code");

    expect(account.provider).toBe("claude-code");
    expect(account.authenticated).toBe(true);
    expect(account.email).toBeTruthy();
    expect(account.organization).toBeTruthy();
    expect(account.usage?.length).toBeGreaterThan(0);
    for (const meter of account.usage ?? []) {
      expect(typeof meter.percentUsed).toBe("number");
      expect(Number.isNaN(Date.parse(meter.resetsAt))).toBe(false);
    }
  });

  it("fetchAccount('codex') returns an authenticated account with no usage meters", async () => {
    const actions = createMockProviderAccountActions("mach-1");
    const account = await actions.fetchAccount("codex");

    expect(account.provider).toBe("codex");
    expect(account.authenticated).toBe(true);
    expect(account.email).toBeTruthy();
    expect(account.usage).toBeUndefined();
  });
});
