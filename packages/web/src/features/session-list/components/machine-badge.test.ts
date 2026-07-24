import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionListMachine } from "../types";
import { MachineBadge } from "./machine-badge";

function machine(overrides: Partial<SessionListMachine> = {}): SessionListMachine {
  return { id: "mach-1", name: "vy-macbook-pro", online: true, status: "online", ...overrides };
}

// AH8 "machine-status-reauth" (docs/auth-ux-hardening-plan.md item 8): the chip must read
// as a genuinely distinct state, not just an offline dot with different CSS underneath.
describe("MachineBadge", () => {
  it("renders 'Needs re-authentication' — not 'Offline' — for a needs-reauth machine", () => {
    const html = renderToStaticMarkup(
      createElement(MachineBadge, { machine: machine({ status: "needs-reauth" }) }),
    );
    expect(html).toContain("Needs re-authentication");
    expect(html).not.toContain(">Offline<");
  });

  it("renders 'Offline' for a plain offline machine", () => {
    const html = renderToStaticMarkup(
      createElement(MachineBadge, { machine: machine({ status: "offline", online: false }) }),
    );
    expect(html).toContain("Offline");
    expect(html).not.toContain("Needs re-authentication");
  });

  it("renders distinct dot colors for offline vs. needs-reauth", () => {
    const offlineHtml = renderToStaticMarkup(
      createElement(MachineBadge, { machine: machine({ status: "offline", online: false }) }),
    );
    const reauthHtml = renderToStaticMarkup(
      createElement(MachineBadge, { machine: machine({ status: "needs-reauth" }) }),
    );
    expect(offlineHtml).toContain("bg-muted-foreground/40");
    expect(reauthHtml).toContain("bg-amber-500");
    expect(reauthHtml).not.toContain("bg-muted-foreground/40");
  });
});
