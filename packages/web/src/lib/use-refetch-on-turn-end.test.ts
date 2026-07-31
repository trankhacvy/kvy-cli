import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useRefetchOnTurnEnd } from "./use-refetch-on-turn-end";

/**
 * Same constraint as `use-refetch-on-machine-recovery.test.ts`: this
 * package's vitest runs with no jsdom and `renderToStaticMarkup` never
 * flushes effects, so a real multi-render true->false transition can't be
 * exercised here. What this DOES prove: mounting alone, at any `working`
 * value, never synchronously invokes `onTurnEnd` during render — the
 * transition can only ever fire from inside the (here, never-run) effect.
 */
describe("useRefetchOnTurnEnd", () => {
  it("never calls onTurnEnd synchronously while working during the initial render", () => {
    const onTurnEnd = vi.fn();
    function Harness() {
      useRefetchOnTurnEnd(true, onTurnEnd);
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    expect(onTurnEnd).not.toHaveBeenCalled();
  });

  it("never calls onTurnEnd synchronously while idle during the initial render", () => {
    const onTurnEnd = vi.fn();
    function Harness() {
      useRefetchOnTurnEnd(false, onTurnEnd);
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    expect(onTurnEnd).not.toHaveBeenCalled();
  });
});
