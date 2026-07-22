"use client";

import {
  MachineBadge,
  type SessionListMachine,
  useLiveSessionListSnapshot,
} from "@/features/session-list";
import type { ProviderAccountProvider, UseProviderAccountActions } from "../types";
import { useLiveProviderAccountActions } from "../use-live-provider-account-actions";
import { ProviderAccountCard } from "./ProviderAccountCard";

const PROVIDERS: ProviderAccountProvider[] = ["claude-code", "codex"];

/**
 * Settings → Providers (docs/competitive-notes-omnara.md #9 "Provider
 * account inspection + usage metering"): one section per known machine,
 * each with a Claude Code and a Codex account card. Reuses
 * `features/session-list`'s `useLiveSessionListSnapshot` for the machine
 * list (id/decrypted name/online) rather than re-deriving it — that hook
 * already owns "which machines does this account have, with what
 * decrypted name and live presence", the same "one place owns this"
 * reasoning `@/lib/use-machine-crypto.ts`'s own doc comment gives for why
 * it lives in `lib/` instead of being redone per feature.
 *
 * `useSnapshot`/`useActions` are the injectable seams (mirrors
 * `GitDiffPanel`'s `useActions` prop) — defaulting to the real
 * `useLiveSessionListSnapshot`/`useLiveProviderAccountActions`, with
 * `mock-source.ts`'s mock kept available for tests/standalone review.
 */
export function ProvidersSettingsScreen({
  useSnapshot = useLiveSessionListSnapshot,
  useActions = useLiveProviderAccountActions,
}: {
  useSnapshot?: typeof useLiveSessionListSnapshot;
  useActions?: UseProviderAccountActions;
}) {
  const snapshot = useSnapshot();

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Account status and usage for each provider, per machine — read straight from that
          machine's own local CLI config, refreshed on demand.
        </p>
      </div>

      {snapshot.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading machines…</p>
      ) : snapshot.machines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No machines registered yet — start a session from a machine to see its provider accounts
          here.
        </p>
      ) : (
        <div className="flex flex-col gap-8">
          {snapshot.machines.map((machine) => (
            <MachineProvidersSection key={machine.id} machine={machine} useActions={useActions} />
          ))}
        </div>
      )}
    </main>
  );
}

function MachineProvidersSection({
  machine,
  useActions,
}: {
  machine: SessionListMachine;
  useActions: UseProviderAccountActions;
}) {
  // Called once per machine section — the resulting `actions` client (one
  // per machine, not one per provider card) is shared by both provider
  // cards below, same "one client, many callers" shape
  // `createMachineRpcClient` is built for.
  const actions = useActions(machine.id);

  return (
    <section className="flex flex-col gap-3">
      <MachineBadge machine={machine} />
      <div className="grid gap-3 sm:grid-cols-2">
        {PROVIDERS.map((provider) => (
          <ProviderAccountCard
            key={provider}
            machineId={machine.id}
            provider={provider}
            actions={actions}
          />
        ))}
      </div>
    </section>
  );
}
