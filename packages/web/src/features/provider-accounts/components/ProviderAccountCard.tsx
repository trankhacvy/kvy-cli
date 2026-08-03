"use client";

import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PROVIDER_META } from "@/features/new-session/provider-meta";
import { formatAuthType, formatBillingType, formatLastRefreshed } from "../format";
import type { ProviderAccountActions, ProviderAccountProvider } from "../types";
import { useProviderAccount } from "../use-provider-account";
import { UsageMeterBar } from "./UsageMeterBar";

/**
 * One provider's account card: auth
 * type, email, organization, org role, billing type, last-refreshed
 * timestamp, and a usage meter — read straight from the target machine's
 * local CLI config via `actions.fetchAccount` (the `provider.account`
 * machine RPC). A manual refresh button re-runs the same fetch — this is a
 * point-in-time snapshot, not a live-pushed value (`use-provider-account.ts`'s
 * doc comment).
 */
export function ProviderAccountCard({
  machineId,
  provider,
  actions,
}: {
  machineId: string;
  provider: ProviderAccountProvider;
  actions: ProviderAccountActions;
}) {
  const { account, error, isLoading, isRefreshing, refresh } = useProviderAccount(
    actions,
    machineId,
    provider,
  );
  const meta = PROVIDER_META[provider];
  const billingLabel = account ? formatBillingType(account.billingType) : null;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{meta.label}</CardTitle>
        <CardAction>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => refresh()}
            disabled={isLoading || isRefreshing}
            aria-label={`Refresh ${meta.label} account info`}
          >
            <RefreshCwIcon className={isRefreshing ? "animate-spin" : undefined} />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-32" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">Could not load account info: {error}</p>
        ) : !account ? null : !account.authenticated ? (
          <p className="text-sm text-muted-foreground">
            Not signed in to {meta.label} on this machine.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Auth</dt>
              <dd>{formatAuthType(account.authType)}</dd>
              {account.email ? (
                <>
                  <dt className="text-muted-foreground">Email</dt>
                  <dd className="truncate">{account.email}</dd>
                </>
              ) : null}
              {account.organization ? (
                <>
                  <dt className="text-muted-foreground">Organization</dt>
                  <dd className="truncate">{account.organization}</dd>
                </>
              ) : null}
              {account.organizationRole ? (
                <>
                  <dt className="text-muted-foreground">Role</dt>
                  <dd className="capitalize">{account.organizationRole}</dd>
                </>
              ) : null}
              {billingLabel ? (
                <>
                  <dt className="text-muted-foreground">Billing</dt>
                  <dd>{billingLabel}</dd>
                </>
              ) : null}
            </dl>

            {account.usage && account.usage.length > 0 ? (
              <div className="flex flex-col gap-3 border-t border-border pt-3">
                {account.usage.map((meter) => (
                  <UsageMeterBar key={meter.label} meter={meter} />
                ))}
              </div>
            ) : null}

            <p className="text-xs text-muted-foreground">
              {formatLastRefreshed(account.lastRefreshedAt)}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
