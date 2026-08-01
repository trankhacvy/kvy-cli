import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProviderAccountInfo } from "./providerAccountInfo.js";

function base64url(json: unknown): string {
  return Buffer.from(JSON.stringify(json))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Builds a syntactically-valid (unsigned) JWT string carrying `claims` as its payload — good enough for `decodeJwtPayload`, which never verifies a signature. */
function fakeJwt(claims: unknown): string {
  return `${base64url({ alg: "none" })}.${base64url(claims)}.sig`;
}

describe("getProviderAccountInfo — claude-code", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "kvy-provider-account-claude-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("is not authenticated when there's no config file and no API key env var", async () => {
    const result = await getProviderAccountInfo({ provider: "claude-code" }, { homeDir, env: {} });
    expect(result).toEqual({ provider: "claude-code", authenticated: false });
  });

  it("reports api-key auth from ANTHROPIC_API_KEY when there's no oauthAccount on disk", async () => {
    const result = await getProviderAccountInfo(
      { provider: "claude-code" },
      { homeDir, env: { ANTHROPIC_API_KEY: "sk-ant-test" } },
    );
    expect(result).toEqual({ provider: "claude-code", authenticated: true, authType: "api-key" });
  });

  it("reads email/organization/billing/usage from ~/.claude.json's oauthAccount + cachedUsageUtilization", async () => {
    writeFileSync(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          emailAddress: "dev@example.com",
          organizationName: "dev@example.com's Organization",
          organizationRole: "admin",
          billingType: "stripe_subscription",
          profileFetchedAt: 1_700_000_000_000,
        },
        cachedUsageUtilization: {
          utilization: {
            five_hour: { utilization: 19, resets_at: "2026-07-19T07:30:00.000Z" },
            seven_day: { utilization: 93, resets_at: "2026-07-20T18:00:00.000Z" },
          },
        },
      }),
    );

    const result = await getProviderAccountInfo({ provider: "claude-code" }, { homeDir, env: {} });

    expect(result).toEqual({
      provider: "claude-code",
      authenticated: true,
      authType: "oauth",
      email: "dev@example.com",
      organization: "dev@example.com's Organization",
      organizationRole: "admin",
      billingType: "stripe_subscription",
      lastRefreshedAt: 1_700_000_000_000,
      usage: [
        { label: "Session", percentUsed: 19, resetsAt: "2026-07-19T07:30:00.000Z" },
        { label: "Weekly", percentUsed: 93, resetsAt: "2026-07-20T18:00:00.000Z" },
      ],
    });
  });

  it("omits a usage bucket the cache hasn't populated (no resets_at) instead of fabricating it", async () => {
    writeFileSync(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "dev@example.com" },
        cachedUsageUtilization: {
          utilization: { five_hour: { utilization: 10 }, seven_day: null },
        },
      }),
    );

    const result = await getProviderAccountInfo({ provider: "claude-code" }, { homeDir, env: {} });
    expect(result.usage).toEqual([]);
  });

  it("treats a malformed config file as absent rather than throwing", async () => {
    writeFileSync(path.join(homeDir, ".claude.json"), "{ not valid json");
    await expect(
      getProviderAccountInfo({ provider: "claude-code" }, { homeDir, env: {} }),
    ).resolves.toEqual({ provider: "claude-code", authenticated: false });
  });
});

describe("getProviderAccountInfo — codex", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "kvy-provider-account-codex-"));
    mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("is not authenticated when there's no auth file and no API key env var", async () => {
    const result = await getProviderAccountInfo({ provider: "codex" }, { homeDir, env: {} });
    expect(result).toEqual({ provider: "codex", authenticated: false });
  });

  it("reports api-key auth from OPENAI_API_KEY when there's no auth file", async () => {
    const result = await getProviderAccountInfo(
      { provider: "codex" },
      { homeDir, env: { OPENAI_API_KEY: "sk-test" } },
    );
    expect(result).toEqual({ provider: "codex", authenticated: true, authType: "api-key" });
  });

  it("decodes email/organization/plan from the auth file's id_token claims", async () => {
    const idToken = fakeJwt({
      email: "dev@example.com",
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "free",
        organizations: [{ title: "Personal", role: "owner", is_default: true }],
      },
    });
    writeFileSync(
      path.join(homeDir, ".codex", "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { id_token: idToken },
        last_refresh: "2026-07-15T02:44:47.677Z",
      }),
    );

    const result = await getProviderAccountInfo({ provider: "codex" }, { homeDir, env: {} });

    expect(result).toEqual({
      provider: "codex",
      authenticated: true,
      authType: "chatgpt",
      email: "dev@example.com",
      organization: "Personal",
      organizationRole: "owner",
      billingType: "free",
      lastRefreshedAt: Date.parse("2026-07-15T02:44:47.677Z"),
    });
  });

  it("picks the default-flagged organization when there's more than one", async () => {
    const idToken = fakeJwt({
      email: "dev@example.com",
      "https://api.openai.com/auth": {
        organizations: [
          { title: "Other Org", role: "member", is_default: false },
          { title: "Main Org", role: "owner", is_default: true },
        ],
      },
    });
    writeFileSync(
      path.join(homeDir, ".codex", "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: idToken } }),
    );

    const result = await getProviderAccountInfo({ provider: "codex" }, { homeDir, env: {} });
    expect(result.organization).toBe("Main Org");
    expect(result.organizationRole).toBe("owner");
  });

  it("still reports authenticated:true with no account detail when the id token is undecodable", async () => {
    writeFileSync(
      path.join(homeDir, ".codex", "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "not-a-jwt" } }),
    );

    const result = await getProviderAccountInfo({ provider: "codex" }, { homeDir, env: {} });
    expect(result).toEqual({
      provider: "codex",
      authenticated: true,
      authType: "chatgpt",
      lastRefreshedAt: undefined,
    });
  });

  it("treats a malformed auth file as absent rather than throwing", async () => {
    writeFileSync(path.join(homeDir, ".codex", "auth.json"), "{ not valid json");
    await expect(
      getProviderAccountInfo({ provider: "codex" }, { homeDir, env: {} }),
    ).resolves.toEqual({ provider: "codex", authenticated: false });
  });
});
