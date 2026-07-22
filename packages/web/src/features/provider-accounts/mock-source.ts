import { useMemo } from "react";
import type {
  ProviderAccountActions,
  ProviderAccountProvider,
  ProviderAccountSnapshot,
  UseProviderAccountActions,
} from "./types";

/**
 * Settings → Providers' default data source — mirrors `features/git-diff/
 * mock-source.ts`'s role: a live per-machine crypto client isn't guaranteed
 * to be ready everywhere this feature might be reviewed standalone, so this
 * simulates the daemon's `provider.account` RPC against realistic-looking
 * fixture data, kept to the same call signature (`ProviderAccountActions`)
 * so swapping in the real `machineRpcToProviderAccountActions` is a
 * one-line change at the call site.
 */

const LATENCY_MS = 200;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MOCK_ACCOUNTS: Record<ProviderAccountProvider, ProviderAccountSnapshot> = {
  "claude-code": {
    provider: "claude-code",
    authenticated: true,
    authType: "oauth",
    email: "dev@example.com",
    organization: "dev@example.com's Organization",
    organizationRole: "admin",
    billingType: "stripe_subscription",
    lastRefreshedAt: Date.now() - 6 * 60 * 1000,
    usage: [
      {
        label: "Session",
        percentUsed: 19,
        resetsAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      },
      {
        label: "Weekly",
        percentUsed: 100,
        resetsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
  },
  codex: {
    provider: "codex",
    authenticated: true,
    authType: "chatgpt",
    email: "dev@example.com",
    organization: "Personal",
    organizationRole: "owner",
    billingType: "free",
    lastRefreshedAt: Date.now() - 60 * 60 * 1000,
    // Codex's local auth file caches no usage-utilization snapshot — see
    // `providerAccountInfo.ts`'s doc comment — so the mock honestly omits
    // it too rather than inventing a meter the real RPC never returns.
  },
};

export function createMockProviderAccountActions(_machineId: string): ProviderAccountActions {
  return {
    async fetchAccount(provider) {
      await delay(LATENCY_MS);
      return MOCK_ACCOUNTS[provider];
    },
  };
}

/** `useMemo`'d on `machineId` so a real hook backed by a live `ProviderAccountActions` client (which shouldn't reseal/reconnect every render) can be swapped in without changing this call site's shape. */
export const useMockProviderAccountActions: UseProviderAccountActions = (machineId) =>
  useMemo(() => createMockProviderAccountActions(machineId), [machineId]);
