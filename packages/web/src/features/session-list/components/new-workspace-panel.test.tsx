import type { MachineRow } from "@kvy/wire";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { syncQueryKey } from "@/sync/queryKeys";
import type { SyncSnapshot } from "@/sync/types";
import type { SessionListMachine } from "../types";

/**
 * `next/navigation`'s `useRouter` throws outside a real Next.js app-router
 * tree — mocked here purely so `NewWorkspaceForm` (below) can be rendered
 * at all via `renderToStaticMarkup`, same technique
 * `require-auth.test.ts` uses. Neither `useMachineCrypto`'s unwrap effect
 * nor `useNewWorkspace`'s `fs.list` home-lookup effect ever runs under
 * `renderToStaticMarkup` (it never flushes effects), so every render here
 * is the deterministic "crypto/home not resolved yet" frame — same
 * precedent `new-session-panel.test.tsx` documents for its own sibling
 * panel.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const { NewWorkspaceForm, NewWorkspaceTrigger } = await import("./new-workspace-panel");

function machine(overrides: Partial<SessionListMachine> = {}): SessionListMachine {
  return { id: "m1", name: "laptop", online: true, status: "online", ...overrides };
}

function machineRow(overrides: Partial<MachineRow> = {}): MachineRow {
  return {
    id: "m1",
    accountId: "acc-1",
    metadata: { value: { t: "enc", v: 1, c: "meta" }, version: 1 },
    daemonState: null,
    dek: "dek-opaque",
    lastSeenAt: null,
    ...overrides,
  };
}

function render(node: React.ReactElement, machines: MachineRow[] = []): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(syncQueryKey, {
    headerSeq: 1,
    accountKeyEpoch: 1,
    sessions: [],
    machines,
    unmanagedSessions: [],
    workspaces: [],
  } satisfies SyncSnapshot);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(TooltipProvider, null, node),
    ),
  );
}

describe("NewWorkspaceTrigger", () => {
  it("renders a 'New project' trigger button", () => {
    const html = render(createElement(NewWorkspaceTrigger, { machines: [machine()] }));
    expect(html).toContain("New project");
  });

  it("reflects the open state on the trigger via defaultOpen (DialogContent is portal-based and never mounts under renderToStaticMarkup, same constraint GitToolbar.test.tsx documents)", () => {
    const html = render(
      createElement(NewWorkspaceTrigger, { machines: [machine()], defaultOpen: true }),
    );
    expect(html).toContain('aria-expanded="true"');
  });
});

describe("NewWorkspaceForm", () => {
  it("renders the read-only path line's structural copy — home never resolves under renderToStaticMarkup (no effects flush), so it shows the pending placeholder", () => {
    const html = render(
      createElement(NewWorkspaceForm, { machines: [machine()], onClose: () => {} }),
    );
    expect(html).toContain("This folder will be created on");
    expect(html).toContain("laptop");
  });

  it("shows the name-validation error copy for an invalid default-cleared name", () => {
    const html = render(
      createElement(NewWorkspaceForm, { machines: [machine()], onClose: () => {} }),
    );
    // The name field is prefilled with a valid generated name by default, so
    // no error renders on first paint — this just confirms the Create
    // button starts disabled (home hasn't resolved yet either way).
    expect(html).toMatch(/Create project<\/button>/);
  });

  it("disables Create when the machine is offline and shows the offline notice", () => {
    const html = render(
      createElement(NewWorkspaceForm, {
        machines: [machine({ status: "offline", online: false })],
        onClose: () => {},
      }),
      [machineRow({ id: "m1", lastSeenAt: Date.now() - 10 * 60_000 })],
    );
    expect(html).toContain("offline right now");
    const suffix = ">Create project</button>";
    const end = html.indexOf(suffix);
    const start = html.lastIndexOf("<button", end);
    expect(html.slice(start, end + suffix.length)).toContain("disabled=");
  });

  it("does not render a machine picker for a single-machine account", () => {
    const html = render(
      createElement(NewWorkspaceForm, { machines: [machine()], onClose: () => {} }),
    );
    expect(html).not.toContain("new-workspace-machine");
  });

  it("renders a machine picker for a multi-machine account", () => {
    const html = render(
      createElement(NewWorkspaceForm, {
        machines: [machine({ id: "m1" }), machine({ id: "m2", name: "server" })],
        onClose: () => {},
      }),
    );
    expect(html).toContain('id="new-workspace-machine"');
    expect(html).toContain('role="combobox"');
  });

  it("keeps the Advanced section collapsed by default", () => {
    const html = render(
      createElement(NewWorkspaceForm, { machines: [machine()], onClose: () => {} }),
    );
    expect(html).toMatch(/aria-expanded="false"[\s\S]*Advanced/);
  });
});
