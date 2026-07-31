/**
 * `provider.account` machine RPC handler (docs/competitive-notes-omnara.md
 * #9 "Provider account inspection + usage metering"; `@falcon/wire`'s
 * `rpc.ts` doc comment above `ProviderAccountResultSchema`). Settings →
 * Providers' per-machine, per-provider account card: email, organization,
 * org role, billing type, last-refreshed timestamp, and a usage meter —
 * read straight off the local CLI's own auth config files, never a live
 * call to the provider's own API (this machine's daemon has no Anthropic/
 * OpenAI API credentials of its own to make one with).
 *
 * Two independent readers, one per provider, matching this codebase's
 * "best-effort throughout, swallow-and-degrade rather than throw" auth
 * convention (`provider/claudeAuth.ts`'s doc comment): a missing, unreadable,
 * or unexpectedly-shaped config file degrades to an honest
 * `{authenticated: false}` (or a partial result with only the fields that
 * genuinely parsed), never a thrown error or fabricated data.
 *
 * - Claude Code (`~/.claude.json`): the CLI's own settings/state file (not
 *   `~/.claude/.credentials.json`, which only ever holds the raw OAuth
 *   token — `provider/claudeAuth.ts`'s concern, not this one). Its
 *   `oauthAccount` object is exactly the account metadata this feature
 *   wants (email/org/role/billing type/`profileFetchedAt`), and its
 *   `cachedUsageUtilization.utilization.{five_hour,seven_day}` is the same
 *   usage-limit snapshot Claude Code's own UI reads to show "X% used ·
 *   resets <date>" — both are written by the CLI itself each time it talks
 *   to Anthropic, so reading them here is a point-in-time snapshot of
 *   whenever the CLI last refreshed, not a live read.
 * - Codex (`~/.codex/auth.json`): `auth_mode: "chatgpt"` stores a real
 *   OIDC `id_token` (a JWT) under `tokens.id_token` — its payload carries
 *   email/name/org/plan-type claims. Decoded here without signature
 *   verification (`decodeJwtPayload`): this is a token our own machine
 *   already holds and trusts, being read back for local display only, never
 *   presented anywhere as proof of identity. Codex's auth file caches no
 *   usage-utilization snapshot analogous to Claude's, so `usage` is simply
 *   omitted for it rather than fabricated.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ProviderAccountResult, ProviderId, ProviderUsageMeter } from "@falcon/wire";

export interface ProviderAccountInfoParams {
  provider: ProviderId;
}

export interface ProviderAccountInfoDeps {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

const CLAUDE_CONFIG_RELATIVE_PATH = [".claude.json"];
const CODEX_AUTH_RELATIVE_PATH = [".codex", "auth.json"];

interface ClaudeUsageLimit {
  utilization?: number;
  resets_at?: string;
}

interface ClaudeUsageUtilization {
  utilization?: {
    five_hour?: ClaudeUsageLimit | null;
    seven_day?: ClaudeUsageLimit | null;
  };
}

interface ClaudeOauthAccount {
  emailAddress?: string;
  organizationName?: string;
  organizationRole?: string | null;
  billingType?: string;
  profileFetchedAt?: number;
}

interface ClaudeConfigFile {
  oauthAccount?: ClaudeOauthAccount;
  cachedUsageUtilization?: ClaudeUsageUtilization;
}

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: { id_token?: string };
  last_refresh?: string;
}

interface CodexOrganization {
  title?: string;
  role?: string;
  is_default?: boolean;
}

interface CodexIdTokenClaims {
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_plan_type?: string;
    organizations?: CodexOrganization[];
  };
}

/** Reads and JSON-parses `filePath`, returning `null` for a missing, unreadable, or malformed file rather than throwing — same "absent, not broken" contract as `claudeAuth.ts`'s `hasCredentialsFile`. */
function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/** `Date.parse` of a possibly-absent/malformed ISO string, degrading to `undefined` (never `NaN`) either way. */
function parseTimestamp(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Decodes a JWT's payload segment without verifying its signature — safe here because this is a token the local machine already holds and trusts, read back for display only and never used to authenticate anything. Malformed/missing input degrades to `null`, never throws. */
function decodeJwtPayload<T>(token: string): T | null {
  const segments = token.split(".");
  if (segments.length < 2) return null;
  const payload = segments[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Extracts the two usage windows Claude Code's own cache tracks — absent entries (a bucket the CLI hasn't populated, e.g. no `resets_at` yet) are skipped rather than rendered as a bogus 0%/no-reset-date meter. */
function claudeUsageMeters(cached: ClaudeUsageUtilization | undefined): ProviderUsageMeter[] {
  const meters: ProviderUsageMeter[] = [];
  const fiveHour = cached?.utilization?.five_hour;
  if (fiveHour && typeof fiveHour.utilization === "number" && fiveHour.resets_at) {
    meters.push({
      label: "Session",
      percentUsed: fiveHour.utilization,
      resetsAt: fiveHour.resets_at,
    });
  }
  const sevenDay = cached?.utilization?.seven_day;
  if (sevenDay && typeof sevenDay.utilization === "number" && sevenDay.resets_at) {
    meters.push({
      label: "Weekly",
      percentUsed: sevenDay.utilization,
      resetsAt: sevenDay.resets_at,
    });
  }
  return meters;
}

function getClaudeAccountInfo(env: NodeJS.ProcessEnv, homeDir: string): ProviderAccountResult {
  const config = readJsonFile<ClaudeConfigFile>(path.join(homeDir, ...CLAUDE_CONFIG_RELATIVE_PATH));
  const account = config?.oauthAccount;

  if (account?.emailAddress) {
    return {
      provider: "claude-code",
      authenticated: true,
      authType: "oauth",
      email: account.emailAddress,
      organization: account.organizationName,
      organizationRole: account.organizationRole ?? undefined,
      billingType: account.billingType,
      lastRefreshedAt: account.profileFetchedAt,
      usage: claudeUsageMeters(config?.cachedUsageUtilization),
    };
  }

  // No decryptable OAuth account on disk — fall back to the same bare
  // env-var check `claudeAuth.ts` uses for API-key auth. Never fabricates
  // email/org for it: an API key has no account identity to show.
  if (env.ANTHROPIC_API_KEY?.trim() || env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    return { provider: "claude-code", authenticated: true, authType: "api-key" };
  }

  return { provider: "claude-code", authenticated: false };
}

function getCodexAccountInfo(env: NodeJS.ProcessEnv, homeDir: string): ProviderAccountResult {
  const auth = readJsonFile<CodexAuthFile>(path.join(homeDir, ...CODEX_AUTH_RELATIVE_PATH));
  const lastRefreshedAt = parseTimestamp(auth?.last_refresh);

  if (!auth) {
    if (env.OPENAI_API_KEY?.trim()) {
      return { provider: "codex", authenticated: true, authType: "api-key" };
    }
    return { provider: "codex", authenticated: false };
  }

  const idToken = auth.tokens?.id_token;
  const claims = idToken ? decodeJwtPayload<CodexIdTokenClaims>(idToken) : null;

  if (!claims) {
    // The auth file exists but there's no decodable id token (API-key mode,
    // or an unexpected shape) — still "authenticated" whenever the CLI has
    // *some* auth mode recorded, just with no account detail to show.
    return {
      provider: "codex",
      authenticated: Boolean(auth.auth_mode) || Boolean(auth.OPENAI_API_KEY?.trim()),
      authType: auth.auth_mode,
      lastRefreshedAt,
    };
  }

  const claimedOrgs = claims["https://api.openai.com/auth"]?.organizations ?? [];
  const org = claimedOrgs.find((o) => o.is_default) ?? claimedOrgs[0];

  return {
    provider: "codex",
    authenticated: true,
    authType: auth.auth_mode ?? "chatgpt",
    email: claims.email,
    organization: org?.title,
    organizationRole: org?.role,
    billingType: claims["https://api.openai.com/auth"]?.chatgpt_plan_type,
    lastRefreshedAt,
    // Codex's local auth file caches no usage-utilization snapshot
    // analogous to Claude's `cachedUsageUtilization` — `usage` is honestly
    // omitted rather than invented.
  };
}

/** Reads `params.provider`'s account info off this machine's local CLI config. Never throws — every failure mode (missing file, malformed JSON, undecodable token) degrades to a partial or `{authenticated: false}` result. */
export async function getProviderAccountInfo(
  params: ProviderAccountInfoParams,
  deps: ProviderAccountInfoDeps = {},
): Promise<ProviderAccountResult> {
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? homedir();
  return params.provider === "claude-code"
    ? getClaudeAccountInfo(env, homeDir)
    : getCodexAccountInfo(env, homeDir);
}
