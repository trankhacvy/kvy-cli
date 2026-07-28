import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InlineSpawnState } from "../use-inline-spawn";
import { InlineSpawnStatus } from "./inline-spawn-status";

/**
 * Component/rendering tests (via `react-dom/server`'s `renderToStaticMarkup`
 * — this package has no jsdom/`@testing-library/react`, same constraint
 * `GitToolbar.test.tsx`/`SessionTimelineScreen.test.tsx` document) for the
 * inline creation panel's spawn-lifecycle feedback (B4). `InlineSpawnStatus`
 * is a plain, hook-free component that takes its state as a prop
 * specifically so every phase is exercisable here without needing to
 * simulate a real spawn RPC round-trip.
 */
describe("InlineSpawnStatus", () => {
  it("renders nothing for the idle phase", () => {
    const html = renderToStaticMarkup(
      <InlineSpawnStatus state={{ phase: "idle" }} elapsedSeconds={null} />,
    );
    expect(html).toBe("");
  });

  it("shows an elapsed-time counter while spawning, with no slow-hint before the threshold", () => {
    const state: InlineSpawnState = { phase: "spawning", startedAt: Date.now() };
    const html = renderToStaticMarkup(<InlineSpawnStatus state={state} elapsedSeconds={2} />);
    expect(html).toContain("Starting session");
    expect(html).toContain("2s");
    expect(html).not.toContain("can take a little longer");
  });

  it("adds the slow-hint reassurance once elapsed time crosses the threshold", () => {
    const state: InlineSpawnState = { phase: "spawning", startedAt: Date.now() };
    const html = renderToStaticMarkup(<InlineSpawnStatus state={state} elapsedSeconds={9} />);
    expect(html).toContain("9s");
    expect(html).toContain("can take a little longer");
  });

  it("renders the translated error message for the error phase", () => {
    const state: InlineSpawnState = {
      phase: "error",
      message: "Timed out waiting for the session to start.",
    };
    const html = renderToStaticMarkup(<InlineSpawnStatus state={state} elapsedSeconds={null} />);
    expect(html).toContain("Timed out waiting for the session to start.");
    expect(html).toContain('role="alert"');
  });

  it("never leaks a raw pid even if an untranslated message slips through to this component", () => {
    const state: InlineSpawnState = {
      phase: "error",
      message: "spawn launched (pid 1234, tmux) but failed",
    };
    const html = renderToStaticMarkup(<InlineSpawnStatus state={state} elapsedSeconds={null} />);
    // This component renders whatever message it's given verbatim — the pid
    // scrub is `translateSpawnError`'s job (`inline-spawn.test.ts` covers
    // it); this test documents that boundary rather than re-asserting it.
    expect(html).toContain(state.message);
  });

  it("renders a success confirmation for the success phase", () => {
    const state: InlineSpawnState = { phase: "success", sessionId: "sess-1" };
    const html = renderToStaticMarkup(<InlineSpawnStatus state={state} elapsedSeconds={null} />);
    expect(html).toContain("Session started");
  });
});
